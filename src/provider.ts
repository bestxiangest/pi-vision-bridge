import type { AssistantMessage, Context, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Artifact } from "./artifacts.js";
import { readArtifactData } from "./artifacts.js";
import type { VisionConfig } from "./config.js";
import { buildRepairPrompt, buildVisionPrompt, VISION_SYSTEM_PROMPT } from "./vision-prompts.js";
import { parseVisionObservation, type VisionMode, type VisionObservation } from "./vision-schema.js";

export const VISION_PROVIDER_ID = "pi-vision-bridge";

export interface VisionCallResult {
	observation: VisionObservation;
	usage: Usage;
	rawText: string;
}

export function registerVisionProvider(pi: ExtensionAPI, config: VisionConfig, apiKey: string | undefined): void {
	pi.unregisterProvider(VISION_PROVIDER_ID);
	if (!config.baseUrl || !apiKey) return;
	pi.registerProvider(VISION_PROVIDER_ID, {
		name: "Pi Vision Bridge",
		baseUrl: config.baseUrl,
		apiKey,
		authHeader: true,
		api: "openai-completions",
		models: [
			{
				id: config.model,
				name: config.model,
				reasoning: config.enableThinking,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: config.responseDetail === "detailed" ? 8_192 : 4_096,
				compat: config.preset === "dashscope" ? { thinkingFormat: "qwen", supportsReasoningEffort: false } : undefined,
			},
		],
	});
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
	constructor(private readonly config: VisionConfig) {}

	private resolveModel(ctx: ExtensionContext): Model<"openai-completions"> {
		const model = ctx.modelRegistry.find(VISION_PROVIDER_ID, this.config.model);
		if (!model) throw new Error("Vision provider is not configured. Run /vision-settings.");
		if (!model.input.includes("image")) throw new Error(`Configured model ${model.id} is not marked as image-capable`);
		return model as Model<"openai-completions">;
	}

	private async complete(ctx: ExtensionContext, model: Model<"openai-completions">, content: string | (ImageContent | { type: "text"; text: string })[], signal?: AbortSignal): Promise<AssistantMessage> {
		const provider = ctx.modelRegistry.getProvider(VISION_PROVIDER_ID);
		if (!provider) throw new Error("Vision provider is unavailable");
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
			timeoutMs: this.config.timeoutMs,
			maxRetries: 1,
			onPayload: (payload) => {
				if (!this.config.enableThinking) return payload;
				if (!payload || typeof payload !== "object") return payload;
				return { ...(payload as Record<string, unknown>), enable_thinking: true };
			},
		});
		return stream.result();
	}

	async inspect(input: {
		ctx: ExtensionContext;
		artifacts: Artifact[];
		objective: string;
		mode: VisionMode;
		comparison?: boolean;
		signal?: AbortSignal;
	}): Promise<VisionCallResult> {
		if (!input.objective.trim()) throw new Error("Vision objective cannot be empty");
		const model = this.resolveModel(input.ctx);
		const images = await Promise.all(input.artifacts.map(readArtifactData));
		const prompt = buildVisionPrompt({
			objective: input.objective,
			mode: input.mode,
			detail: this.config.responseDetail,
			imageCount: images.length,
			comparison: input.comparison,
		});
		const response = await this.complete(input.ctx, model, [{ type: "text", text: prompt }, ...images], input.signal);
		let rawText = responseText(response);
		let usage = response.usage;
		let parsed: unknown;
		try {
			parsed = parseJsonObject(rawText);
		} catch {
			const repair = await this.complete(input.ctx, model, buildRepairPrompt(rawText), input.signal);
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
}
