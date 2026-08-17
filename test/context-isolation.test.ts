import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import sharp from "sharp";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";

import { ArtifactStore } from "../src/artifacts.js";
import { DEFAULT_CONFIG, getConfigPaths, type ConfigPaths } from "../src/config.js";
import { VisionClient, VISION_PROVIDER_ID } from "../src/provider.js";
import { VISION_SYSTEM_PROMPT } from "../src/vision-prompts.js";

const EMPTY_USAGE: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Proves the session-isolation contract end to end: the context handed to the
 * vision provider contains ONLY the vision system prompt and the single
 * objective+image user message — never any main-session conversation history,
 * no matter how large that session is. This is what keeps vision-call latency
 * independent of the active session's context size.
 */
describe("vision context isolation", () => {
	it("sends only the vision system prompt and one user message to the vision provider", async () => {
		const captured: Context[] = [];
		const capturedMessages: unknown[][] = [];
		const fakeProvider = {
			stream: (model: Model<"openai-completions">, context: Context) => {
				captured.push(context);
				capturedMessages.push(context.messages.map((message) => ({ role: message.role, content: message.content })));
				const response: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: JSON.stringify({ summary: "ok", observations: [], uncertainties: [] }) }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: EMPTY_USAGE,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				return { result: async () => response };
			},
		};
		const model: Model<"openai-completions"> = {
			id: "vision-model",
			name: "vision-model",
			provider: VISION_PROVIDER_ID,
			api: "openai-completions",
			baseUrl: "https://vision.example/v1",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 128_000,
			maxTokens: 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
			headers: undefined,
		} as unknown as Model<"openai-completions">;
		const ctx = {
			modelRegistry: {
				find: () => model,
				getProvider: () => fakeProvider,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
		};

		const root = await mkdtemp(join(tmpdir(), "pi-vision-isolation-"));
		try {
			const paths: ConfigPaths = getConfigPaths(root);
			const store = new ArtifactStore(paths, DEFAULT_CONFIG);
			const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).png().toBuffer();
			const artifact = await store.ingestImage({ type: "image", data: png.toString("base64"), mimeType: "image/png" });

			const client = new VisionClient(DEFAULT_CONFIG);
			const result = await client.inspectOnce(client.primaryTarget(), {
				ctx: ctx as never,
				artifacts: [artifact],
				objective: "What is this screenshot?",
				mode: "general",
			});

			assert.equal(result.observation.summary, "ok");
			assert.equal(captured.length, 1, "exactly one vision request");
			const sent = captured[0];
			assert.equal(sent.systemPrompt, VISION_SYSTEM_PROMPT);
			assert.equal(sent.messages.length, 1, "no session history is forwarded");
			assert.equal(sent.messages[0]?.role, "user");
			const content = sent.messages[0]!.content;
			const blocks = Array.isArray(content) ? content : [];
			const text = blocks.find((block) => block.type === "text");
			const image = blocks.find((block) => block.type === "image");
			assert.ok(text && typeof text.text === "string" && text.text.includes("What is this screenshot?"));
			assert.ok(image, "the image bytes travel with the request");
			// The request must not reference the main session in any way.
			const serialized = JSON.stringify(capturedMessages[0]);
			assert.doesNotMatch(serialized, /user>|assistant>|tool_result|session|history/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
