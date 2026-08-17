import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_CONFIG,
	getConfigPaths,
	loadConfig,
	loadCredentials,
	normalizeConfig,
	saveCredentials,
	saveGlobalConfig,
	saveProjectConfig,
	shouldUseVisionBridge,
} from "../src/config.js";

describe("configuration", () => {
	it("normalizes limits and rejects invalid endpoints without throwing", () => {
		const config = normalizeConfig({
			baseUrl: "ftp://invalid.example",
			timeoutMs: 1,
			maxImages: 999,
			routing: "unknown",
		});
		assert.equal(config.baseUrl, "");
		assert.equal(normalizeConfig({ baseUrl: "https://user:pass@example.test/v1?token=bad" }).baseUrl, "");
		assert.equal(config.timeoutMs, 5_000);
		assert.equal(config.maxImages, 32);
		assert.equal(normalizeConfig({ maxConcurrentRequests: 0 }).maxConcurrentRequests, 1);
		assert.equal(normalizeConfig({ maxConcurrentRequests: 99 }).maxConcurrentRequests, 16);
		assert.equal(normalizeConfig({}).maxConcurrentRequests, 4);
		assert.equal(config.routing, DEFAULT_CONFIG.routing);
	});

	it("keeps credentials out of project configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-config-"));
		const env = { PI_CODING_AGENT_DIR: join(root, "global") };
		const paths = getConfigPaths(root, ".pi", env);
		await saveGlobalConfig(paths, { ...DEFAULT_CONFIG, baseUrl: "https://example.test/v1" });
		await saveProjectConfig(paths, { model: "project-model", apiKey: "should-not-write" } as never);
		await saveCredentials(paths, "secret-value");
		const projectText = await readFile(paths.projectConfigPath, "utf8");
		assert.equal(projectText.includes("secret-value"), false);
		assert.equal(projectText.includes("apiKey"), false);
		assert.equal((await loadCredentials(paths))?.apiKey, "secret-value");
		const loaded = await loadConfig(root, ".pi", true, env);
		assert.equal(loaded.config.model, "project-model");
		assert.equal(loaded.config.baseUrl, "https://example.test/v1");
		const globalOnly = await loadConfig(root, ".pi", false, env);
		assert.equal(globalOnly.config.model, DEFAULT_CONFIG.model);
	});

	it("limits the bridge to configured text-only main models", () => {
		const config = normalizeConfig({ enabledMainModels: ["deepseek/*", "custom/provider-model"] });
		assert.equal(
			shouldUseVisionBridge(config, { provider: "deepseek", id: "deepseek-v4-flash", input: ["text"] }),
			true,
		);
		assert.equal(
			shouldUseVisionBridge(config, { provider: "custom", id: "provider-model", input: ["text"] }),
			true,
		);
		assert.equal(
			shouldUseVisionBridge(config, { provider: "openai", id: "gpt-4o", input: ["text"] }),
			false,
		);
		assert.equal(
			shouldUseVisionBridge(config, { provider: "openai", id: "gpt-4o", input: ["text", "image"] }),
			false,
		);
		assert.equal(shouldUseVisionBridge({ ...config, enabledMainModels: [] }, undefined), true);
	});

	it("parses retry, fallback, audit, and local-only settings", () => {
		const config = normalizeConfig({
			maxRetries: 99,
			fallbackModel: "  fallback-model  ",
			fallbackBaseUrl: "https://fallback.example/v1",
			auditEnabled: false,
			localOnly: true,
		});
		assert.equal(config.maxRetries, 6); // clamped
		assert.equal(config.fallbackModel, "fallback-model"); // trimmed
		assert.equal(config.fallbackBaseUrl, "https://fallback.example/v1");
		assert.equal(config.auditEnabled, false);
		assert.equal(config.localOnly, true);
		assert.equal(normalizeConfig({ maxRetries: -3 }).maxRetries, 0);
		assert.equal(normalizeConfig({}).maxRetries, DEFAULT_CONFIG.maxRetries);
		assert.equal(normalizeConfig({}).localOnly, false);
	});

	it("parses upload encoding limits", () => {
		assert.equal(normalizeConfig({ uploadMaxEdgePx: 99 }).uploadMaxEdgePx, 512); // clamped
		assert.equal(normalizeConfig({ uploadMaxEdgePx: 4096 }).uploadMaxEdgePx, 4096);
		assert.equal(normalizeConfig({ uploadMaxBytes: -5 }).uploadMaxBytes, 128 * 1024);
		assert.equal(normalizeConfig({}).uploadMaxEdgePx, DEFAULT_CONFIG.uploadMaxEdgePx);
		assert.equal(normalizeConfig({}).uploadMaxBytes, DEFAULT_CONFIG.uploadMaxBytes);
		assert.equal(DEFAULT_CONFIG.uploadMaxEdgePx, 1792); // token-optimal tile boundary on the target VL models
		assert.equal(DEFAULT_CONFIG.hedgeRequests, true); // min-of-two parallel draws beat stochastic reasoning windows
	});

	it("stores a separate fallback API key in credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-creds-"));
		const paths = getConfigPaths(root, ".pi", { PI_CODING_AGENT_DIR: join(root, "global") });
		await saveCredentials(paths, "primary-secret", "fallback-secret");
		const loaded = await loadCredentials(paths);
		assert.equal(loaded?.apiKey, "primary-secret");
		assert.equal(loaded?.fallbackApiKey, "fallback-secret");
		await saveCredentials(paths, "primary-secret");
		const withoutFallback = await loadCredentials(paths);
		assert.equal(withoutFallback?.fallbackApiKey, undefined);
	});
});
