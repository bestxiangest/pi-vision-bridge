import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

import {
	clearCredentials,
	formatEnabledMainModels,
	maskSecret,
	normalizeConfig,
	saveCredentials,
	saveGlobalConfig,
	saveProjectConfig,
	type ConfigPaths,
	type VisionConfig,
} from "./config.js";

export interface SettingsState {
	config: VisionConfig;
	apiKey?: string;
	fallbackApiKey?: string;
	paths: ConfigPaths;
}

class SecretPrompt implements Component, Focusable {
	focused = true;
	private value = "";

	constructor(
		private readonly title: string,
		private readonly renderTitle: (text: string) => string,
		private readonly finish: (value: string | undefined) => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, "enter")) {
			this.finish(this.value);
			return;
		}
		if (matchesKey(data, "backspace") || data === "\u007f") {
			this.value = this.value.slice(0, -1);
			this.requestRender();
			return;
		}
		const printable = data
			.replace(/\u001b\[200~/g, "")
			.replace(/\u001b\[201~/g, "")
			.replace(/[\u0000-\u001f\u007f]/g, "");
		if (printable) {
			this.value += printable;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const available = Math.max(1, width - 4);
		const mask = "*".repeat(Math.min(this.value.length, available));
		return [this.renderTitle(this.title), `> ${mask}${this.focused ? CURSOR_MARKER : ""}`, "Enter to save, Esc to cancel"];
	}

	invalidate(): void {}
}

async function promptSecret(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		return new SecretPrompt(title, (text) => theme.fg("accent", theme.bold(text)), done, () => tui.requestRender());
	});
}

function compactUrl(url: string): string {
	if (!url) return "not configured";
	return url.length <= 42 ? url : `${url.slice(0, 18)}...${url.slice(-18)}`;
}

function mib(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

async function inputNumber(ctx: ExtensionCommandContext, title: string, current: number): Promise<number | undefined> {
	const value = await ctx.ui.input(title, String(current));
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		ctx.ui.notify("Enter a valid number", "error");
		return undefined;
	}
	return parsed;
}

export async function runSettings(
	ctx: ExtensionCommandContext,
	state: SettingsState,
	scope: "global" | "project",
	onSave: (next: SettingsState) => Promise<void>,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/vision-settings requires Pi TUI mode", "error");
		return;
	}
	let config = { ...state.config };
	let apiKey = state.apiKey;
	let fallbackApiKey = state.fallbackApiKey;
	let credentialsChanged = false;

	while (true) {
		const options = [
			`Preset: ${config.preset}`,
			`Base URL: ${compactUrl(config.baseUrl)}`,
			`Model: ${config.model}`,
			`Enabled main models: ${formatEnabledMainModels(config.enabledMainModels)}`,
			`API Key: ${maskSecret(apiKey)}`,
			`Fallback API Key: ${maskSecret(fallbackApiKey)}`,
			`Fallback model: ${config.fallbackModel || "none"}`,
			`Fallback base URL: ${compactUrl(config.fallbackBaseUrl)}`,
			`Routing: ${config.routing}`,
			`Upload confirmation: ${config.uploadConfirmation}`,
			`Response detail: ${config.responseDetail}`,
			`Thinking: ${config.enableThinking ? "on" : "off"}`,
			`Timeout: ${Math.round(config.timeoutMs / 1000)} s`,
			`Retries: ${config.maxRetries}`,
			`Max image size: ${mib(config.maxImageBytes)}`,
			`Max pixels: ${config.maxPixels}`,
			`Upload max edge: ${config.uploadMaxEdgePx} px`,
			`Upload max size: ${mib(config.uploadMaxBytes)}`,
			`Max images: ${config.maxImages}`,
			`Max follow-ups: ${config.maxFollowupsPerTurn}`,
			`Cache: ${config.cacheEnabled ? "on" : "off"}`,
			`Cache TTL: ${config.cacheTtlHours} h`,
			`Cache limit: ${mib(config.cacheMaxBytes)}`,
			`Audit log: ${config.auditEnabled ? "on" : "off"}`,
			`Local-only: ${config.localOnly ? "on" : "off"}`,
			"Save and close",
			"Discard changes",
		];
		const choice = await ctx.ui.select(`Pi Vision Bridge settings (${scope})`, options);
		if (!choice || choice === "Discard changes") return;
		if (choice === "Save and close") {
			config = normalizeConfig(config);
			if (scope === "global") await saveGlobalConfig(state.paths, config);
			else await saveProjectConfig(state.paths, config);
			if (credentialsChanged) {
				if (apiKey) await saveCredentials(state.paths, apiKey, fallbackApiKey);
				else await clearCredentials(state.paths);
			}
			await onSave({ config, apiKey, fallbackApiKey, paths: state.paths });
			ctx.ui.notify("Pi Vision Bridge settings saved", "info");
			return;
		}

		if (choice.startsWith("Preset:")) {
			const preset = await ctx.ui.select("Provider preset", ["dashscope", "custom"]);
			if (preset === "dashscope" || preset === "custom") config.preset = preset;
			continue;
		}
		if (choice.startsWith("Base URL:")) {
			if (config.preset === "dashscope") {
				const region = await ctx.ui.select("DashScope endpoint", ["Beijing workspace", "Singapore workspace", "Tokyo workspace", "US Virginia", "Enter custom URL"]);
				if (region === "US Virginia") config.baseUrl = "https://dashscope-us.aliyuncs.com/compatible-mode/v1";
				else if (region && region !== "Enter custom URL") {
					const workspace = await ctx.ui.input("Workspace ID", "Enter the DashScope workspace ID");
					if (workspace) {
						const host = region === "Beijing workspace" ? "cn-beijing" : region === "Singapore workspace" ? "ap-southeast-1" : "ap-northeast-1";
						config.baseUrl = `https://${workspace}.${host}.maas.aliyuncs.com/compatible-mode/v1`;
					}
				}
				if (region !== "Enter custom URL") continue;
			}
			const value = await ctx.ui.input("OpenAI-compatible base URL", config.baseUrl || "https://host.example/v1");
			if (value !== undefined) config.baseUrl = value.trim();
			continue;
		}
		if (choice.startsWith("Model:")) {
			const value = await ctx.ui.input("Vision model ID", config.model);
			if (value?.trim()) config.model = value.trim();
			continue;
		}
		if (choice.startsWith("Enabled main models:")) {
			const value = await ctx.ui.input(
				"Main model patterns (comma-separated; empty = all text-only models)",
				config.enabledMainModels.join(", "),
			);
			if (value !== undefined) config.enabledMainModels = value.split(",").map((entry) => entry.trim()).filter(Boolean);
			continue;
		}
		if (choice.startsWith("Fallback model:")) {
			const value = await ctx.ui.input("Fallback vision model ID (empty to disable)", config.fallbackModel);
			if (value !== undefined) config.fallbackModel = value.trim();
			continue;
		}
		if (choice.startsWith("Fallback base URL:")) {
			const value = await ctx.ui.input("Separate OpenAI-compatible fallback endpoint (empty = same endpoint)", config.fallbackBaseUrl || "https://host.example/v1");
			if (value !== undefined) config.fallbackBaseUrl = value.trim();
			continue;
		}
		if (choice.startsWith("API Key:")) {
			const action = await ctx.ui.select("API key", ["Set API key", "Set fallback API key", "Clear API key", "Clear fallback API key", "Cancel"]);
			if (action === "Set API key") {
				const value = await promptSecret(ctx, "Enter API key (masked)");
				if (value?.trim()) {
					apiKey = value.trim();
					credentialsChanged = true;
				}
			} else if (action === "Set fallback API key") {
				const value = await promptSecret(ctx, "Enter fallback API key (masked)");
				if (value?.trim()) {
					fallbackApiKey = value.trim();
					credentialsChanged = true;
				}
			} else if (action === "Clear API key") {
				apiKey = undefined;
				credentialsChanged = true;
			} else if (action === "Clear fallback API key") {
				fallbackApiKey = undefined;
				credentialsChanged = true;
			}
			continue;
		}
		if (choice.startsWith("Routing:")) {
			const value = await ctx.ui.select("Routing mode", ["tool-first", "fallback-auto", "off"]);
			if (value === "tool-first" || value === "fallback-auto" || value === "off") config.routing = value;
			continue;
		}
		if (choice.startsWith("Upload confirmation:")) {
			const value = await ctx.ui.select("Remote upload confirmation", ["always", "once", "never"]);
			if (value === "always" || value === "once" || value === "never") config.uploadConfirmation = value;
			continue;
		}
		if (choice.startsWith("Response detail:")) {
			const value = await ctx.ui.select("Response detail", ["concise", "balanced", "detailed"]);
			if (value === "concise" || value === "balanced" || value === "detailed") config.responseDetail = value;
			continue;
		}
		if (choice.startsWith("Thinking:")) {
			config.enableThinking = !config.enableThinking;
			continue;
		}
		if (choice.startsWith("Cache:")) {
			config.cacheEnabled = !config.cacheEnabled;
			continue;
		}
		if (choice.startsWith("Audit log:")) {
			config.auditEnabled = !config.auditEnabled;
			continue;
		}
		if (choice.startsWith("Local-only:")) {
			config.localOnly = !config.localOnly;
			continue;
		}

		const numeric: Array<[string, keyof VisionConfig, number]> = [
			["Timeout:", "timeoutMs", 1000],
			["Retries:", "maxRetries", 1],
			["Max image size:", "maxImageBytes", 1024 * 1024],
			["Max pixels:", "maxPixels", 1],
			["Upload max edge:", "uploadMaxEdgePx", 1],
			["Upload max size:", "uploadMaxBytes", 1024 * 1024],
			["Max images:", "maxImages", 1],
			["Max follow-ups:", "maxFollowupsPerTurn", 1],
			["Cache TTL:", "cacheTtlHours", 1],
			["Cache limit:", "cacheMaxBytes", 1024 * 1024],
		];
		const target = numeric.find(([prefix]) => choice.startsWith(prefix));
		if (target) {
			const [prefix, key, multiplier] = target;
			const current = Number(config[key]) / multiplier;
			const value = await inputNumber(ctx, prefix.replace(":", ""), current);
			if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value * multiplier;
		}
	}
}
