import type { AssistantMessage, Context, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Artifact } from "./artifacts.js";
import { readArtifactData } from "./artifacts.js";
import type { VisionConfig } from "./config.js";
import { RequestQueue } from "./request-queue.js";
import { classifyError, withRetry } from "./resilience.js";
import { buildRepairPrompt, buildVisionPrompt, VISION_SYSTEM_PROMPT } from "./vision-prompts.js";
import { parseVisionObservation, type VisionMode, type VisionObservation } from "./vision-schema.js";

export const VISION_PROVIDER_ID = "pi-vision-bridge";
export const VISION_FALLBACK_PROVIDER_ID = "pi-vision-bridge-fallback";

export interface VisionCallResult {
	observation: VisionObservation;
	usage: Usage;
	rawText: string;
}

/** A concrete endpoint+model pair that can be asked to analyze images. */
export interface VisionTarget {
	providerId: string;
	modelId: string;
}

function registerProvider(
	pi: ExtensionAPI,
	providerId: string,
	name: string,
	config: VisionConfig,
	baseUrl: string,
	modelIds: string[],
	apiKey: string,
): void {
	pi.unregisterProvider(providerId);
	pi.registerProvider(providerId, {
		name,
		baseUrl,
		apiKey,
		authHeader: true,
		api: "openai-completions",
		models: [...new Set(modelIds.filter(Boolean))].map((modelId) => ({
			id: modelId,
			name: modelId,
			reasoning: config.enableThinking,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: config.responseDetail === "detailed" ? 8_192 : 4_096,
			compat: config.preset === "dashscope" ? { thinkingFormat: "qwen", supportsReasoningEffort: false } : undefined,
		})),
	});
}

/**
 * Registers the primary vision provider and, when a separate fallback
 * endpoint is configured, a second provider for it. Same-endpoint fallbacks
 * (fallbackModel without fallbackBaseUrl) reuse the primary provider.
 */
export function registerVisionProvider(
	pi: ExtensionAPI,
	config: VisionConfig,
	apiKey: string | undefined,
	fallbackApiKey?: string,
): void {
	pi.unregisterProvider(VISION_PROVIDER_ID);
	pi.unregisterProvider(VISION_FALLBACK_PROVIDER_ID);
	if (!config.baseUrl || !apiKey) return;
	const primaryModels = config.fallbackBaseUrl || !config.fallbackModel
		? [config.model]
		: [config.model, config.fallbackModel];
	registerProvider(pi, VISION_PROVIDER_ID, "Pi Vision Bridge", config, config.baseUrl, primaryModels, apiKey);
	if (config.fallbackBaseUrl && config.fallbackModel && fallbackApiKey) {
		registerProvider(pi, VISION_FALLBACK_PROVIDER_ID, "Pi Vision Bridge Fallback", config, config.fallbackBaseUrl, [config.fallbackModel], fallbackApiKey);
	}
}

function responseText(response: AssistantMessage): string {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Vision request ${response.stopReason}`);
	}
	return response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function parseJsonObject(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error("Vision response did not contain a JSON object");
	}
}

function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export class VisionClient {
	private readonly requestQueue: RequestQueue;

	constructor(
		private readonly config: VisionConfig,
		private readonly fallbackApiKey?: string,
	) {
		this.requestQueue = new RequestQueue(config.maxConcurrentRequests);
	}

	primaryTarget(): VisionTarget {
		return { providerId: VISION_PROVIDER_ID, modelId: this.config.model };
	}

	/** Same-endpoint fallback model, or a separate endpoint when configured. */
	fallbackTarget(): VisionTarget | undefined {
		if (!this.config.fallbackModel.trim()) return undefined;
		if (this.config.fallbackBaseUrl) {
			return this.fallbackApiKey ? { providerId: VISION_FALLBACK_PROVIDER_ID, modelId: this.config.fallbackModel } : undefined;
		}
		return { providerId: VISION_PROVIDER_ID, modelId: this.config.fallbackModel };
	}

	private resolveModel(ctx: ExtensionContext, target: VisionTarget): Model<"openai-completions"> {
		const model = ctx.modelRegistry.find(target.providerId, target.modelId);
		if (!model) throw new Error(`Vision model ${target.modelId} is not registered. Run /vision-settings.`);
		if (!model.input.includes("image")) throw new Error(`Configured model ${target.modelId} is not marked as image-capable`);
		return model as Model<"openai-completions">;
	}

	private async complete(
		ctx: ExtensionContext,
		target: VisionTarget,
		content: string | (ImageContent | { type: "text"; text: string })[],
		signal?: AbortSignal,
	): Promise<AssistantMessage> {
		const provider = ctx.modelRegistry.getProvider(target.providerId);
		if (!provider) throw new Error(`Vision provider ${target.providerId} is unavailable`);
		const model = this.resolveModel(ctx, target);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const context: Context = {
			systemPrompt: VISION_SYSTEM_PROMPT,
			messages: [{ role: "user", content, timestamp: Date.now() }],
		};
		return this.requestQueue.run(() => {
			const stream = provider.stream(model, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				timeoutMs: this.config.timeoutMs,
				maxRetries: 0,
				onPayload: (payload) => {
					if (!this.config.enableThinking) return payload;
					if (!payload || typeof payload !== "object") return payload;
					return { ...(payload as Record<string, unknown>), enable_thinking: true };
				},
			});
			return stream.result();
		}, signal);
	}

	async inspectOnce(target: VisionTarget, input: {
		ctx: ExtensionContext;
		artifacts: Artifact[];
		objective: string;
		mode: VisionMode;
		comparison?: boolean;
		signal?: AbortSignal;
	}): Promise<VisionCallResult> {
		if (!input.objective.trim()) throw new Error("Vision objective cannot be empty");
		const model = this.resolveModel(input.ctx, target);
		const images = await Promise.all(input.artifacts.map(readArtifactData));
		const prompt = buildVisionPrompt({
			objective: input.objective,
			mode: input.mode,
			detail: this.config.responseDetail,
			imageCount: images.length,
			comparison: input.comparison,
		});
		const response = await this.complete(input.ctx, target, [{ type: "text", text: prompt }, ...images], input.signal);
		let rawText = responseText(response);
		let usage = response.usage;
		let parsed: unknown;
		try {
			parsed = parseJsonObject(rawText);
		} catch {
			const repair = await this.complete(input.ctx, target, buildRepairPrompt(rawText), input.signal);
			rawText = responseText(repair);
			usage = addUsage(usage, repair.usage);
			parsed = parseJsonObject(rawText);
		}
		return {
			observation: parseVisionObservation(parsed, {
				artifactIds: input.artifacts.map((artifact) => artifact.id),
				mode: input.mode,
				model: model.id,
			}),
			usage,
			rawText,
		};
	}

	/**
	 * Runs the primary target with exponential-backoff retries for retryable
	 * failures (5xx/429/network). On a fatal primary failure or exhausted
	 * retries, a configured fallback target is tried once. Aborts propagate.
	 */
	async inspect(input: {
		ctx: ExtensionContext;
		artifacts: Artifact[];
		objective: string;
		mode: VisionMode;
		comparison?: boolean;
		signal?: AbortSignal;
	}): Promise<VisionCallResult & { usedFallback: boolean }> {
		const primary = this.primaryTarget();
		try {
			const { value } = await withRetry(() => this.inspectOnce(primary, input), {
				maxRetries: this.config.maxRetries,
				signal: input.signal,
			});
			return { ...value, usedFallback: false };
		} catch (error) {
			if (classifyError(error, input.signal) === "abort") throw error;
			const fallback = this.fallbackTarget();
			if (!fallback) throw error;
			const value = await this.inspectOnce(fallback, input);
			return { ...value, usedFallback: true };
		}
	}
}
