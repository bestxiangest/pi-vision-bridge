import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VisionPreset = "dashscope" | "custom";
export type RoutingMode = "tool-first" | "fallback-auto" | "off";
export type UploadConfirmation = "always" | "once" | "never";
export type ResponseDetail = "concise" | "balanced" | "detailed";

export interface VisionConfig {
	version: 1;
	preset: VisionPreset;
	baseUrl: string;
	model: string;
	/** Main-model refs (provider/model, model id, or wildcard). Empty means any text-only model. */
	enabledMainModels: string[];
	routing: RoutingMode;
	uploadConfirmation: UploadConfirmation;
	responseDetail: ResponseDetail;
	enableThinking: boolean;
	timeoutMs: number;
	maxImageBytes: number;
	maxPixels: number;
	maxImages: number;
	maxFollowupsPerTurn: number;
	cacheEnabled: boolean;
	cacheTtlHours: number;
	cacheMaxBytes: number;
}

export interface VisionCredentials {
	version: 1;
	apiKey: string;
}

export interface ConfigPaths {
	globalDir: string;
	globalConfigPath: string;
	projectConfigPath: string;
	credentialsPath: string;
	cacheDir: string;
}

export interface LoadedConfig {
	config: VisionConfig;
	paths: ConfigPaths;
	warnings: string[];
}

export const DEFAULT_CONFIG: VisionConfig = {
	version: 1,
	preset: "dashscope",
	baseUrl: "",
	model: "qwen3.7-flash",
	enabledMainModels: [],
	routing: "tool-first",
	uploadConfirmation: "always",
	responseDetail: "balanced",
	enableThinking: false,
	timeoutMs: 60_000,
	maxImageBytes: 20 * 1024 * 1024,
	maxPixels: 20_000_000,
	maxImages: 8,
	maxFollowupsPerTurn: 3,
	cacheEnabled: true,
	cacheTtlHours: 168,
	cacheMaxBytes: 512 * 1024 * 1024,
};

const CONFIG_FILE = "config.json";
const PROJECT_FILE = "project.json";
const CREDENTIALS_FILE = "credentials.json";
const CACHE_DIR = "cache";

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function stringEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function modelPatterns(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.slice(0, 32);
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	try {
		const parsed = new URL(value.trim());
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fallback;
		if (parsed.username || parsed.password || parsed.search || parsed.hash) return fallback;
		return value.trim().replace(/\/+$/, "");
	} catch {
		return fallback;
	}
}

export function normalizeConfig(raw: unknown, base: VisionConfig = DEFAULT_CONFIG): VisionConfig {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		version: 1,
		preset: stringEnum(input.preset, ["dashscope", "custom"], base.preset),
		baseUrl: normalizeBaseUrl(input.baseUrl, base.baseUrl),
		model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : base.model,
		enabledMainModels: modelPatterns(input.enabledMainModels, base.enabledMainModels),
		routing: stringEnum(input.routing, ["tool-first", "fallback-auto", "off"], base.routing),
		uploadConfirmation: stringEnum(input.uploadConfirmation, ["always", "once", "never"], base.uploadConfirmation),
		responseDetail: stringEnum(input.responseDetail, ["concise", "balanced", "detailed"], base.responseDetail),
		enableThinking: typeof input.enableThinking === "boolean" ? input.enableThinking : base.enableThinking,
		timeoutMs: numberInRange(input.timeoutMs, base.timeoutMs, 5_000, 10 * 60_000),
		maxImageBytes: numberInRange(input.maxImageBytes, base.maxImageBytes, 64 * 1024, 20 * 1024 * 1024),
		maxPixels: numberInRange(input.maxPixels, base.maxPixels, 1024, 50_000_000),
		maxImages: numberInRange(input.maxImages, base.maxImages, 1, 32),
		maxFollowupsPerTurn: numberInRange(input.maxFollowupsPerTurn, base.maxFollowupsPerTurn, 0, 12),
		cacheEnabled: typeof input.cacheEnabled === "boolean" ? input.cacheEnabled : base.cacheEnabled,
		cacheTtlHours: numberInRange(input.cacheTtlHours, base.cacheTtlHours, 1, 720),
		cacheMaxBytes: numberInRange(input.cacheMaxBytes, base.cacheMaxBytes, 16 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
	};
}

export function getConfigPaths(cwd: string, configDirName = ".pi", env: NodeJS.ProcessEnv = process.env): ConfigPaths {
	const globalDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	const extensionDir = join(globalDir, "vision-bridge");
	return {
		globalDir: extensionDir,
		globalConfigPath: join(extensionDir, CONFIG_FILE),
		projectConfigPath: join(cwd, configDirName, "vision-bridge", PROJECT_FILE),
		credentialsPath: join(extensionDir, CREDENTIALS_FILE),
		cacheDir: join(extensionDir, CACHE_DIR),
	};
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const content = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(content);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Unable to read JSON configuration at ${path}: ${(error as Error).message}`);
	}
}

export async function loadConfig(
	cwd: string,
	configDirName = ".pi",
	includeProject = true,
	env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
	const paths = getConfigPaths(cwd, configDirName, env);
	const warnings: string[] = [];
	const global = await readJsonFile(paths.globalConfigPath);
	const project = includeProject ? await readJsonFile(paths.projectConfigPath) : undefined;
	let config = normalizeConfig(global);
	if (project) config = normalizeConfig(project, config);
	if (config.baseUrl === "") warnings.push("No vision base URL is configured.");
	return { config, paths, warnings };
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
		await chmod(temporary, mode);
		await rename(temporary, path);
		await chmod(path, mode);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export async function saveGlobalConfig(paths: ConfigPaths, config: VisionConfig): Promise<void> {
	await writeJsonAtomic(paths.globalConfigPath, normalizeConfig(config), 0o600);
}

export async function saveProjectConfig(paths: ConfigPaths, config: Partial<VisionConfig>): Promise<void> {
	const allowed: Partial<VisionConfig> = { ...config };
	delete (allowed as Partial<VisionConfig> & { apiKey?: string }).apiKey;
	await writeJsonAtomic(paths.projectConfigPath, allowed, 0o600);
}

export async function loadCredentials(paths: ConfigPaths): Promise<VisionCredentials | undefined> {
	const value = await readJsonFile(paths.credentialsPath);
	if (!value || typeof value.apiKey !== "string" || value.apiKey.length === 0) return undefined;
	return { version: 1, apiKey: value.apiKey };
}

export async function saveCredentials(paths: ConfigPaths, apiKey: string): Promise<void> {
	if (!apiKey.trim()) throw new Error("API key cannot be empty");
	await writeJsonAtomic(paths.credentialsPath, { version: 1, apiKey: apiKey.trim() }, 0o600);
}

export async function clearCredentials(paths: ConfigPaths): Promise<void> {
	await unlink(paths.credentialsPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}

export function maskSecret(secret: string | undefined): string {
	if (!secret) return "not configured";
	if (secret.length <= 8) return "********";
	return `${secret.slice(0, 3)}${"*".repeat(Math.min(12, secret.length - 6))}${secret.slice(-3)}`;
}

function wildcardPattern(pattern: string): RegExp {
	const escaped = pattern
		.trim()
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "iu");
}

export interface MainModelRef {
	provider: string;
	id: string;
	input?: readonly string[];
}

/** Returns false for native image models even when a wildcard is configured. */
export function shouldUseVisionBridge(config: VisionConfig, model: MainModelRef | undefined): boolean {
	if (!model) return config.enabledMainModels.length === 0;
	if (model.input?.includes("image")) return false;
	if (config.enabledMainModels.length === 0) return true;
	const refs = [`${model.provider}/${model.id}`, model.id];
	return config.enabledMainModels.some((pattern) => refs.some((ref) => wildcardPattern(pattern).test(ref)));
}

export function formatEnabledMainModels(patterns: string[]): string {
	return patterns.length ? patterns.join(", ") : "auto (text-only models)";
}
