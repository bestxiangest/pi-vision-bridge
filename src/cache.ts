import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigPaths, VisionConfig } from "./config.js";
import type { VisionObservation } from "./vision-schema.js";

export const VISION_PROMPT_VERSION = "3";

function cacheKey(parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function makeVisionCacheKey(input: {
	artifactIds: string[];
	objective: string;
	mode: string;
	model: string;
}): string {
	return cacheKey([VISION_PROMPT_VERSION, input.model, input.mode, input.objective.trim(), ...input.artifactIds]);
}

export class VisionCache {
	private readonly directory: string;

	constructor(private readonly paths: ConfigPaths, private readonly config: VisionConfig) {
		this.directory = join(paths.cacheDir, "results");
	}

	private pathFor(key: string): string {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid cache key");
		return join(this.directory, `${key}.json`);
	}

	async get(key: string): Promise<VisionObservation | undefined> {
		if (!this.config.cacheEnabled) return undefined;
		try {
			const path = this.pathFor(key);
			const [raw, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
			if (Date.now() - metadata.mtimeMs > this.config.cacheTtlHours * 60 * 60 * 1000) return undefined;
			return JSON.parse(raw) as VisionObservation;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
	}

	async set(key: string, value: VisionObservation): Promise<void> {
		if (!this.config.cacheEnabled) return;
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await writeFile(this.pathFor(key), `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await this.prune();
	}

	async clear(): Promise<void> {
		await rm(this.directory, { recursive: true, force: true });
	}

	async size(): Promise<number> {
		const files = await readdir(this.directory).catch(() => [] as string[]);
		let total = 0;
		for (const file of files) total += (await stat(join(this.directory, file)).catch(() => ({ size: 0 }))).size;
		return total;
	}

	private async prune(): Promise<void> {
		const files = await readdir(this.directory).catch(() => [] as string[]);
		const entries = await Promise.all(
			files.map(async (file) => {
				const path = join(this.directory, file);
				const metadata = await stat(path).catch(() => undefined);
				return metadata ? { path, mtimeMs: metadata.mtimeMs, size: metadata.size } : undefined;
			}),
		);
		let total = entries.reduce((sum, entry) => sum + (entry?.size ?? 0), 0);
		for (const entry of entries.filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
			if (total <= this.config.cacheMaxBytes) break;
			await rm(entry.path, { force: true });
			total -= entry.size;
		}
	}
}
