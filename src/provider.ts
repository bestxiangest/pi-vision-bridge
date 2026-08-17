import type { AssistantMessage, Context, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Artifact } from "./artifacts.js";
import { readArtifactData } from "./artifacts.js";
import type { VisionConfig, ResponseDetail } from "./config.js";
import { encodeImageForUpload } from "./image-encode.js";
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

/**
 * Response budget per detail level. The reasoning chain-of-thought is
 * uncontrollable (it can run 1000-8000+ chars even with the low-temperature
 * terse prompt), so the caps are a reliability valve, not a throttle: a cap
 * below ~1500 lets reasoning starve the visible JSON entirely (empty response
 * -> whole call wasted). Measured: with the terse prompt + temp 0.1 a typical
 * call completes in 6-16s and needs ~1500-3000 tokens; 4096 leaves enough
 * room that content is always produced.
 */
function responseMaxTokens(detail: ResponseDetail): number {
	return detail === "concise" ? 2048 : detail === "detailed" ? 8192 : 4096;
}

function registerProvider(
	pi: ExtensionAPI,
	providerId: string,
	name: string,
	config: VisionConfig,
	baseUrl: string,
	modelId: string,
	apiKey: string,
): void {
	pi.unregisterProvider(providerId);
	pi.registerProvider(providerId, {
		name,
		baseUrl,
		apiKey,
		authHeader: true,
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: config.enableThinking,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: responseMaxTokens(config.responseDetail),
				compat: config.preset === "dashscope" ? { thinkingFormat: "qwen", supportsReasoningEffort: false } : undefined,
			},
		],
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
	registerProvider(pi, VISION_PROVIDER_ID, "Pi Vision Bridge", config, config.baseUrl, config.model, apiKey);
	if (config.fallbackBaseUrl && config.fallbackModel && fallbackApiKey) {
		registerProvider(pi, VISION_FALLBACK_PROVIDER_ID, "Pi Vision Bridge Fallback", config, config.fallbackBaseUrl, config.fallbackModel, fallbackApiKey);
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

/**
 * Reasoning models can spend their whole token budget on hidden chain-of-thought
 * and return no visible content. Retrying a fresh request (new reasoning budget)
 * is far more reliable than a repair pass over an empty string, which would
 * fabricate evidence. Surfaced as a retryable error so the existing retry policy
 * re-attempts the vision call instead of double-latency repair.
 */
export class EmptyVisionResponseError extends Error {
	constructor() {
		super("Vision model returned no visible content (its reasoning consumed the token budget)");
		this.name = "EmptyVisionResponseError";
	}
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
	constructor(
		private readonly config: VisionConfig,
		private readonly fallbackApiKey?: string,
	) {}

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
		const stream = provider.stream(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			// Low temperature is load-bearing for latency on reasoning vision
			// models: measured on step-3.7-flash, the hidden chain-of-thought
			// shrinks from 2900-8400 chars to ~1300-2100 chars at 0.1 vs the
			// endpoint default (0.5), taking typical calls from 15-40s to 6-8s
			// while keeping the JSON extraction deterministic.
			temperature: 0.1,
			timeoutMs: this.config.timeoutMs,
			maxRetries: 0,
			onPayload: (payload) => {
				if (!this.config.enableThinking) return payload;
				if (!payload || typeof payload !== "object") return payload;
				return { ...(payload as Record<string, unknown>), enable_thinking: true };
			},
		});
		return stream.result();
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
		// The session context never reaches this request: each vision call is a
		// fresh single-turn conversation with only the objective and a shrunk
		// upload copy of the image bytes.
		const images = await Promise.all(
			input.artifacts.map(async (artifact) =>
				encodeImageForUpload(await readArtifactData(artifact), {
					maxEdgePx: this.config.uploadMaxEdgePx,
					maxBytes: this.config.uploadMaxBytes,
				}),
			),
		);
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
		if (!rawText) throw new EmptyVisionResponseError();
		let parsed: unknown;
		try {
			parsed = parseJsonObject(rawText);
		} catch {
			const repair = await this.complete(input.ctx, target, buildRepairPrompt(rawText), input.signal);
			rawText = responseText(repair);
			usage = addUsage(usage, repair.usage);
			if (!rawText) throw new EmptyVisionResponseError();
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
