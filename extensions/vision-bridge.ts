import { rm } from "node:fs/promises";

import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text } from "@earendil-works/pi-tui";

import { ArtifactStore, readArtifactData, type Artifact, type ArtifactReference } from "../src/artifacts.js";
import { appendAuditEntry, auditLogSize, clearAuditEntries, countAuditEntries, tailAuditEntries, truncateError, type AuditEntry } from "../src/audit.js";
import { makeVisionCacheKey, VisionCache } from "../src/cache.js";
import { formatEnabledMainModels, loadConfig, loadCredentials, saveGlobalConfig, shouldUseVisionBridge, type ConfigPaths, type VisionConfig } from "../src/config.js";
import { removeImagePathMarkers, scanLocalImageAttachments } from "../src/image-paths.js";
import { registerVisionProvider, VisionClient } from "../src/provider.js";
import { runSettings } from "../src/tui.js";
import { observationForModel, type VisionMode, type VisionObservation } from "../src/vision-schema.js";

interface RuntimeState {
	config: VisionConfig;
	paths: ConfigPaths;
	apiKey?: string;
	fallbackApiKey?: string;
	artifacts: ArtifactStore;
	cache: VisionCache;
	client: VisionClient;
	uploadApproved: boolean;
	visionCallsThisTurn: number;
	currentArtifacts: ArtifactReference[];
	lastObservation?: VisionObservation;
}

interface VisionToolDetails {
	observation: VisionObservation;
	cacheHit: boolean;
	elapsedMs: number;
	artifactIds: string[];
	hedged?: boolean;
}

function activeModelLabel(ctx: ExtensionContext): string {
	if (!ctx.model) return "no-main-model";
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function updateStatus(state: RuntimeState, ctx: ExtensionContext): void {
	if (state.config.routing === "off") {
		ctx.ui.setStatus("vision-bridge", undefined);
		return;
	}
	const status = !shouldUseVisionBridge(state.config, ctx.model)
		? ctx.model?.input.includes("image")
			? "native-image"
			: "disabled"
		: `vision:${state.config.model}`;
	ctx.ui.setStatus("vision-bridge", status);
}

function buildRuntime(config: VisionConfig, paths: ConfigPaths, apiKey?: string, fallbackApiKey?: string): RuntimeState {
	return {
		config,
		paths,
		apiKey,
		fallbackApiKey,
		artifacts: new ArtifactStore(paths, config),
		cache: new VisionCache(paths, config),
		client: new VisionClient(config, fallbackApiKey),
		uploadApproved: false,
		visionCallsThisTurn: 0,
		currentArtifacts: [],
	};
}

function endpointName(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return "the configured endpoint";
	}
}

async function approveUpload(state: RuntimeState, ctx: ExtensionContext): Promise<void> {
	if (state.config.uploadConfirmation === "never") return;
	if (state.config.uploadConfirmation === "once" && state.uploadApproved) return;
	if (!ctx.hasUI) {
		throw new Error("Remote image upload requires confirmation. Use Pi TUI or set upload confirmation to never.");
	}
	const approved = await ctx.ui.confirm(
		"Upload image for vision analysis?",
		`The selected image data will be sent to ${endpointName(state.config.baseUrl)}.`,
	);
	if (!approved) throw new Error("Image upload was cancelled");
	if (state.config.uploadConfirmation === "once") state.uploadApproved = true;
}

function assertCallBudget(state: RuntimeState): void {
	const limit = 1 + state.config.maxFollowupsPerTurn;
	if (state.visionCallsThisTurn >= limit) throw new Error(`Vision call limit reached for this turn (${limit})`);
	state.visionCallsThisTurn += 1;
}

async function auditQuiet(state: RuntimeState, entry: AuditEntry): Promise<void> {
	if (!state.config.auditEnabled) return;
	try {
		await appendAuditEntry(state.paths, entry);
	} catch {
		// The audit log must never break a vision call.
	}
}

function modeLabel(input: { mode: string; comparison?: boolean }): string {
	return input.comparison ? `compare:${input.mode}` : input.mode;
}

async function executeVision(
	state: RuntimeState,
	ctx: ExtensionContext,
	input: { artifacts: Artifact[]; objective: string; mode: VisionMode; comparison?: boolean; signal?: AbortSignal; allowWhenDisabled?: boolean },
): Promise<{ details: VisionToolDetails; usage?: Usage }> {
	if (!input.allowWhenDisabled && !shouldUseVisionBridge(state.config, ctx.model)) {
		throw new Error(`Pi Vision Bridge is disabled for ${activeModelLabel(ctx)}. Use the main model's native image input or configure Enabled main models.`);
	}
	assertCallBudget(state);
	const artifactIds = input.artifacts.map((artifact) => artifact.id);
	const mode = modeLabel(input);
	const cacheKey = makeVisionCacheKey({
		artifactIds,
		objective: input.objective,
		mode,
		model: state.config.model,
	});
	const cached = await state.cache.get(cacheKey);
	if (cached) {
		state.lastObservation = cached;
		await auditQuiet(state, {
			ts: new Date().toISOString(),
			outcome: "cache",
			model: cached.model,
			mode,
			imageCount: artifactIds.length,
			artifactIds,
			elapsedMs: 0,
		});
		return {
			details: { observation: cached, cacheHit: true, elapsedMs: 0, artifactIds },
		};
	}
	if (state.config.localOnly) {
		throw new Error(
			"local-only mode: no cached vision result exists for this image, and image bytes would leave the machine. Disable local-only in /vision-settings or clear it to allow a remote vision call.",
		);
	}
	await approveUpload(state, ctx);
	const started = Date.now();
	try {
		const result = await state.client.inspect({
			ctx,
			artifacts: input.artifacts,
			objective: input.objective,
			mode: input.mode,
			comparison: input.comparison,
			signal: input.signal,
		});
		if (!result.usedFallback) await state.cache.set(cacheKey, result.observation);
		state.lastObservation = result.observation;
		await auditQuiet(state, {
			ts: new Date().toISOString(),
			outcome: result.usedFallback ? "fallback" : "success",
			model: result.observation.model,
			mode,
			imageCount: artifactIds.length,
			artifactIds,
			elapsedMs: Date.now() - started,
			hedged: result.hedged,
		});
		return {
			details: {
				observation: result.observation,
				cacheHit: false,
				elapsedMs: Date.now() - started,
				artifactIds,
				hedged: result.hedged,
			},
			usage: result.usage,
		};
	} catch (error) {
		await auditQuiet(state, {
			ts: new Date().toISOString(),
			outcome: "failure",
			model: state.config.model,
			mode,
			imageCount: artifactIds.length,
			artifactIds,
			elapsedMs: Date.now() - started,
			error: truncateError(error),
		});
		throw error;
	}
}

function renderCall(label: string, objective: string, theme: { fg: (color: "accent" | "dim", text: string) => string }): Text {
	const shortened = objective.length > 96 ? `${objective.slice(0, 93)}...` : objective;
	return new Text(`${theme.fg("accent", label)} ${theme.fg("dim", shortened)}`);
}

function renderResult(result: { details?: unknown }, expanded: boolean, theme: { fg: (color: "accent" | "dim" | "success", text: string) => string }): Text {
	const details = result.details as VisionToolDetails | undefined;
	if (!details) return new Text(theme.fg("dim", "No vision result"));
	const status = details.cacheHit ? "cache" : `${details.elapsedMs} ms${details.hedged ? " (hedged)" : ""}`;
	const lines = [`${theme.fg("success", "Vision evidence")} ${theme.fg("dim", `(${status})`)}`, details.observation.summary];
	if (expanded) {
		for (const item of details.observation.observations) {
			const box = item.bbox ? ` @ ${item.bbox.join(",")}` : "";
			lines.push(`- [${item.certainty}] ${item.fact}${box}`);
		}
		if (details.observation.uncertainties.length) lines.push(`Uncertain: ${details.observation.uncertainties.join("; ")}`);
	}
	return new Text(lines.join("\n"));
}

function attachmentManifest(references: ArtifactReference[]): string {
	return JSON.stringify(
		{
			attachments: references.map(({ artifact, label }, index) => ({
				image_index: index + 1,
				...(label ? { filename: label } : {}),
				artifact_id: artifact.id,
				width: artifact.width,
				height: artifact.height,
				mime_type: artifact.mimeType,
			})),
		},
		null,
		2,
	);
}

function imageReadBlockReason(path: string, references: ArtifactReference[]): string {
	return [
		`Pi Vision Bridge intercepted read for a local image path: ${path}`,
		"Do not retry the built-in read tool for this image. A text-only model cannot inspect image pixels through read.",
		"Use vision_inspect now. Copy the complete artifact_id from this manifest, including sha256: and all 64 hexadecimal characters, and write a task-specific objective.",
		"[Pi Vision Bridge attachment manifest]",
		attachmentManifest(references),
	].join("\n");
}

export default async function visionBridge(pi: ExtensionAPI): Promise<void> {
	const initialLoaded = await loadConfig(process.cwd(), CONFIG_DIR_NAME, false);
	const initialCredentials = await loadCredentials(initialLoaded.paths);
	let state = buildRuntime(initialLoaded.config, initialLoaded.paths, initialCredentials?.apiKey, initialCredentials?.fallbackApiKey);
	registerVisionProvider(pi, state.config, state.apiKey, state.fallbackApiKey);

	async function reloadForContext(ctx: ExtensionContext): Promise<void> {
		const loaded = await loadConfig(ctx.cwd, CONFIG_DIR_NAME, ctx.isProjectTrusted());
		const credentials = await loadCredentials(loaded.paths);
		state = buildRuntime(loaded.config, loaded.paths, credentials?.apiKey, credentials?.fallbackApiKey);
		registerVisionProvider(pi, state.config, state.apiKey, state.fallbackApiKey);
		for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		updateStatus(state, ctx);
	}

	pi.on("session_start", async (_event, ctx) => reloadForContext(ctx));
	pi.on("turn_start", () => {
		state.visionCallsThisTurn = 0;
	});
	pi.on("model_select", (_event, ctx) => {
		updateStatus(state, ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (state.config.routing === "off" || !shouldUseVisionBridge(state.config, ctx.model)) return;
		return {
			systemPrompt: [
				event.systemPrompt,
				"Pi Vision Bridge image routing: this main model is text-only. If a local path ends in an image extension, do not call the built-in read tool to inspect it. The bridge intercepts image reads and provides an artifact manifest; call vision_inspect with a task-specific objective. Do not claim to see image pixels until the vision tool returns evidence.",
			].join("\n\n"),
		};
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("vision-bridge", undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || state.config.routing === "off") return { action: "continue" };
		const attachedImages = event.images ?? [];
		const localScan = attachedImages.length
			? { attachments: [], unresolved: [] }
			: await scanLocalImageAttachments(event.text, ctx.cwd, {
					maxImages: state.config.maxImages,
					maxImageBytes: state.config.maxImageBytes,
					maxPixels: state.config.maxPixels,
				});
		const recoveredText = removeImagePathMarkers(event.text, localScan.attachments);

		// Pi 0.83 represents macOS clipboard/drop images as local path text. Restore
		// native attachments when the active main model can inspect images itself.
		if (ctx.model?.input.includes("image")) {
			if (!localScan.attachments.length) return { action: "continue" };
			return { action: "transform", text: recoveredText, images: localScan.attachments.map((entry) => entry.image) };
		}
		if (!shouldUseVisionBridge(state.config, ctx.model)) return { action: "continue" };
		const images = [...attachedImages, ...localScan.attachments.map((entry) => entry.image)];
		if (!images.length) {
			if (!localScan.unresolved.length) return { action: "continue" };
			return {
				action: "transform",
				text: `${event.text}\n\n[Pi Vision Bridge could not read the referenced local image. No artifact id exists; do not call vision_inspect with a path or filename.]`,
				images: [],
			};
		}
		if (images.length > state.config.maxImages) {
			return {
				action: "transform",
				text: `${event.text}\n\n[Pi Vision Bridge rejected ${images.length} images because the configured limit is ${state.config.maxImages}.]`,
				images: [],
			};
		}
		try {
			const artifacts = await Promise.all(images.map((image) => state.artifacts.ingestImage(image)));
			state.currentArtifacts = artifacts.map((artifact, index) => ({
				artifact,
				label: localScan.attachments[index - attachedImages.length]?.displayName,
			}));
			const manifest = JSON.stringify(
				{
					attachments: state.currentArtifacts.map(({ artifact, label }, index) => ({
						image_index: index + 1,
						...(label ? { filename: label } : {}),
						artifact_id: artifact.id,
						width: artifact.width,
						height: artifact.height,
						mime_type: artifact.mimeType,
					})),
				},
				null,
				2,
			);
			if (state.config.routing === "fallback-auto") {
				state.visionCallsThisTurn = 0;
				const result = await executeVision(state, ctx, {
					artifacts,
					objective: recoveredText.trim() || "Describe the attached images for the user's next coding decision.",
					mode: "general",
					signal: ctx.signal,
				});
				return {
					action: "transform",
					text: `${recoveredText}\n\n[Pi Vision Bridge visual context]\n${observationForModel(result.details.observation)}`,
					images: [],
				};
			}
			return {
				action: "transform",
				text: [
					recoveredText,
					"",
					"[Pi Vision Bridge attachment manifest]",
					manifest,
					"Tool argument contract: copy the exact artifact_id value beginning with sha256: from this manifest. Never pass a filename or bare digest.",
					"You cannot inspect these image pixels directly. Before visual claims or image-dependent edits, call vision_inspect with a task-specific objective. For UI replication use ui_reverse_engineering; for an exact ratio use ui_geometry; for a disputed region use vision_query with a bbox. Treat observations as evidence and keep observed facts separate from inferred implementation choices.",
				].join("\n"),
				images: [],
			};
		} catch (error) {
			return {
				action: "transform",
				text: `${event.text}\n\n[Pi Vision Bridge could not ingest the attached image: ${(error as Error).message}]`,
				images: [],
			};
			}
		});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event) || state.config.routing === "off" || !shouldUseVisionBridge(state.config, ctx.model)) return;
		const scan = await scanLocalImageAttachments(event.input.path, ctx.cwd, {
			maxImages: state.config.maxImages,
			maxImageBytes: state.config.maxImageBytes,
			maxPixels: state.config.maxPixels,
		});
		if (!scan.attachments.length && !scan.unresolved.length) return;
		if (!scan.attachments.length) {
			return {
				block: true,
				reason: `Pi Vision Bridge could not ingest this image path: ${event.input.path}. Do not retry read; confirm that the file exists, is readable, and is a supported image type.`,
			};
		}
		if (scan.attachments.length > state.config.maxImages) {
			return { block: true, reason: `Pi Vision Bridge rejected this read because it resolved to more than ${state.config.maxImages} images.` };
		}
		const artifacts = await Promise.all(scan.attachments.map(({ image }) => state.artifacts.ingestImage(image)));
		state.currentArtifacts = artifacts.map((artifact, index) => ({ artifact, label: scan.attachments[index]?.displayName }));
		return { block: true, reason: imageReadBlockReason(event.input.path, state.currentArtifacts) };
	});

	pi.registerTool({
		name: "vision_inspect",
		label: "Inspect image",
		description: "Inspect an image artifact for a task-specific objective. Use this before making visual claims or implementing image-dependent changes.",
		promptSnippet: "Inspect attached image artifacts with a task-specific objective",
		promptGuidelines: [
			"Use this bridge only when the active main model is text-only. If the active model accepts image input, inspect the image directly and do not call Pi Vision Bridge tools.",
			"When the user message contains a Pi Vision Bridge attachment manifest, call vision_inspect before answering or editing based on its pixels.",
			"For artifact_id, copy the complete JSON artifact_id value exactly, including the sha256: prefix and all 64 hexadecimal characters. Never use filename, image_index, image 1, or a bare hash.",
			"Write an objective that names the implementation decision, the evidence needed, and the expected output. Example: measure the table's visible bounds and estimate its viewport percentage, showing the calculation basis.",
			"For a rich frontend reference, use ui_reverse_engineering for the first pass, then use vision_query for a disputed region or vision_compare after a current screenshot exists.",
			"Do not ask the vision model to infer hidden DOM, source code, exact animation timing, or behavior that a still image cannot establish.",
		],
		parameters: Type.Object({
			artifact_id: Type.String({
				description: "Exact artifact_id from the Pi Vision Bridge attachment manifest. It starts with sha256: followed by 64 hexadecimal characters. Do not pass a filename, image index, label, or bare digest.",
				examples: ["sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
			}),
			objective: Type.String({ description: "Task-specific question or evidence request for the vision model" }),
			mode: StringEnum(["general", "ocr", "ui_geometry", "ui_reverse_engineering", "chart", "document", "error_screenshot"] as const),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Inspecting image..." }], details: { progress: 20 } });
			const artifact = await state.artifacts.resolveReference(params.artifact_id, state.currentArtifacts);
			const result = await executeVision(state, ctx, { artifacts: [artifact], objective: params.objective, mode: params.mode, signal });
			return { content: [{ type: "text", text: observationForModel(result.details.observation) }], details: result.details, usage: result.usage };
		},
		renderCall: (args, theme) => renderCall("Inspect", args.objective, theme),
		renderResult: (result, options, theme) => renderResult(result, options.expanded, theme),
	});

	pi.registerTool({
		name: "vision_query",
		label: "Query image region",
		description: "Ask a focused follow-up question about an image artifact, optionally cropping to a normalized 0..1000 bounding box.",
		promptSnippet: "Ask a focused visual follow-up question or inspect a region",
		parameters: Type.Object({
			artifact_id: Type.String({ description: "Exact artifact_id value from the attachment manifest, including the sha256: prefix." }),
			question: Type.String(),
			bbox: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),
			mode: Type.Optional(StringEnum(["general", "ocr", "ui_geometry", "error_screenshot"] as const)),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Inspecting image region..." }], details: { progress: 20 } });
			const sourceArtifact = await state.artifacts.resolveReference(params.artifact_id, state.currentArtifacts);
			const artifact = params.bbox
				? await state.artifacts.crop(sourceArtifact.id, params.bbox as [number, number, number, number])
				: sourceArtifact;
			const result = await executeVision(state, ctx, {
				artifacts: [artifact],
				objective: params.question,
				mode: params.mode ?? "general",
				signal,
			});
			return { content: [{ type: "text", text: observationForModel(result.details.observation) }], details: result.details, usage: result.usage };
		},
		renderCall: (args, theme) => renderCall("Query", args.question, theme),
		renderResult: (result, options, theme) => renderResult(result, options.expanded, theme),
	});

	pi.registerTool({
		name: "vision_compare",
		label: "Compare images",
		description: "Compare a target image with a current implementation screenshot and return prioritized visual differences.",
		promptSnippet: "Compare a target design with a current screenshot",
		parameters: Type.Object({
			target_artifact_id: Type.String({ description: "Exact target artifact_id from the attachment manifest, including sha256:." }),
			current_artifact_id: Type.String({ description: "Exact current screenshot artifact_id from the attachment manifest, including sha256:." }),
			objective: Type.String(),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Comparing images..." }], details: { progress: 20 } });
			const artifacts = await Promise.all([
				state.artifacts.resolveReference(params.target_artifact_id, state.currentArtifacts),
				state.artifacts.resolveReference(params.current_artifact_id, state.currentArtifacts),
			]);
			const result = await executeVision(state, ctx, {
				artifacts,
				objective: params.objective,
				mode: "ui_geometry",
				comparison: true,
				signal,
			});
			return { content: [{ type: "text", text: observationForModel(result.details.observation) }], details: result.details, usage: result.usage };
		},
		renderCall: (args, theme) => renderCall("Compare", args.objective, theme),
		renderResult: (result, options, theme) => renderResult(result, options.expanded, theme),
	});

	pi.registerCommand("vision-settings", {
		description: "Configure Pi Vision Bridge",
		handler: async (args, ctx) => {
			const scope = args.trim() === "project" ? "project" : "global";
			if (scope === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify("Project settings require a trusted project", "error");
				return;
			}
			await runSettings(ctx, state, scope, async (next) => {
				state = buildRuntime(next.config, next.paths, next.apiKey, next.fallbackApiKey);
				registerVisionProvider(pi, state.config, state.apiKey, state.fallbackApiKey);
				updateStatus(state, ctx);
			});
		},
	});

	pi.registerCommand("vision-status", {
		description: "Show Pi Vision Bridge status",
		handler: async (_args, ctx) => {
			const cacheSize = await state.cache.size();
			const auditEntries = await countAuditEntries(state.paths).catch(() => 0);
			const fallback = state.config.fallbackBaseUrl
				? `${state.config.fallbackModel}@${endpointName(state.config.fallbackBaseUrl)}`
				: state.config.fallbackModel || "none";
			ctx.ui.notify(
				`model=${state.config.model}, endpoint=${endpointName(state.config.baseUrl)}, key=${state.apiKey ? "configured" : "missing"}, enabled=${formatEnabledMainModels(state.config.enabledMainModels)}, routing=${state.config.routing}, retries=${state.config.maxRetries}, fallback=${fallback}, local-only=${state.config.localOnly ? "on" : "off"}, audit=${state.config.auditEnabled ? `${auditEntries} entries` : "off"}, cache=${Math.round(cacheSize / 1024)} KiB`,
				state.config.baseUrl && state.apiKey ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("vision-test", {
		description: "Test the configured vision endpoint",
		handler: async (_args, ctx) => {
			if (!state.config.baseUrl || !state.apiKey) {
				ctx.ui.notify("Configure a base URL and API key first", "error");
				return;
			}
			if (ctx.hasUI && !(await ctx.ui.confirm("Run vision test?", "This sends a tiny test image and may incur provider usage."))) return;
			state.visionCallsThisTurn = 0;
			const pixel = await state.artifacts.ingestImage({
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			});
			try {
			const result = await executeVision(state, ctx, { artifacts: [pixel], objective: "Confirm that this is a tiny test image.", mode: "general", allowWhenDisabled: true });
				ctx.ui.notify(`Vision endpoint responded in ${result.details.elapsedMs} ms: ${result.details.observation.summary}`, "info");
			} catch (error) {
				ctx.ui.notify(`Vision test failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("vision-cache-clear", {
		description: "Clear Pi Vision Bridge image and result cache",
		handler: async (_args, ctx) => {
			if (ctx.hasUI && !(await ctx.ui.confirm("Clear vision cache?", "Cached image artifacts and vision results will be removed."))) return;
			await rm(state.paths.cacheDir, { recursive: true, force: true });
			state = buildRuntime(state.config, state.paths, state.apiKey, state.fallbackApiKey);
			ctx.ui.notify("Vision cache cleared", "info");
		},
	});

	pi.registerCommand("vision-audit", {
		description: "Show or manage the vision delegation audit log",
		handler: async (args, ctx) => {
			const action = args.trim() || "show";
			if (action === "on") {
				state = { ...state, config: { ...state.config, auditEnabled: true } };
				await saveGlobalConfig(state.paths, state.config).catch(() => undefined);
				ctx.ui.notify("Vision audit log enabled", "info");
				return;
			}
			if (action === "off") {
				state = { ...state, config: { ...state.config, auditEnabled: false } };
				await saveGlobalConfig(state.paths, state.config).catch(() => undefined);
				ctx.ui.notify("Vision audit log disabled", "info");
				return;
			}
			if (action === "clear") {
				if (ctx.hasUI && !(await ctx.ui.confirm("Clear vision audit log?", "All audit entries will be removed."))) return;
				await clearAuditEntries(state.paths);
				ctx.ui.notify("Vision audit log cleared", "info");
				return;
			}
			if (action === "count") {
				ctx.ui.notify(`Vision audit log: ${await countAuditEntries(state.paths)} entries`, "info");
				return;
			}
			// Default: show the most recent entries.
			const [entries, total, size] = await Promise.all([
				tailAuditEntries(state.paths, 8),
				countAuditEntries(state.paths),
				auditLogSize(state.paths),
			]);
			if (!entries.length) {
				ctx.ui.notify("Vision audit log is empty", "info");
				return;
			}
			ctx.ui.notify(`Vision audit log: ${total} entries, ${Math.round(size / 1024)} KiB (${state.config.auditEnabled ? "enabled" : "disabled"})`, "info");
			for (const entry of entries) {
				const outcome = entry.outcome === "fallback" ? "fallback" : entry.outcome;
				const detail = entry.error ? ` error=${entry.error}` : ` ${entry.elapsedMs}ms`;
				ctx.ui.notify(`[${entry.ts.slice(11, 19)}] ${outcome} model=${entry.model} mode=${entry.mode} images=${entry.imageCount}${detail}`, "info");
			}
		},
	});

	pi.registerCommand("vision-last", {
		description: "Preview the last analyzed image and evidence",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !state.lastObservation?.artifactIds[0]) {
				ctx.ui.notify("No visual observation is available in this session", "warning");
				return;
			}
			const artifact = await state.artifacts.get(state.lastObservation.artifactIds[0]);
			const data = await readArtifactData(artifact);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
				box.addChild(new Image(data.data, data.mimeType, { fallbackColor: (text) => theme.fg("dim", text) }, { maxWidthCells: 72, maxHeightCells: 24 }));
				box.addChild(new Text(state.lastObservation?.summary ?? ""));
				box.addChild(new Text(theme.fg("dim", "Press Esc or Enter to close")));
				return {
					render: (width) => box.render(width),
					invalidate: () => box.invalidate(),
					handleInput: (input) => {
						if (input === "\u001b" || input === "\r" || input === "\n") done(undefined);
					},
				};
			});
		},
	});
}
