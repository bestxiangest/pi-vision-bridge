import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { ConfigPaths, VisionConfig } from "./config.js";

export interface Artifact {
	id: string;
	path: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	createdAt: string;
}

export interface ArtifactReference {
	artifact: Artifact;
	label?: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertArtifactId(id: string): void {
	if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image artifact id");
}

function toBuffer(data: string): Buffer {
	const encoded = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
	return Buffer.from(encoded, "base64");
}

function artifactPath(paths: ConfigPaths, id: string, mimeType: string): string {
	assertArtifactId(id);
	const extension = MIME_EXTENSIONS[mimeType] ?? "bin";
	return join(paths.cacheDir, "artifacts", `${id.slice("sha256:".length)}.${extension}`);
}

export class ArtifactStore {
	constructor(private readonly paths: ConfigPaths, private readonly config: VisionConfig) {}

	async ingestImage(image: ImageContent): Promise<Artifact> {
		if (!MIME_EXTENSIONS[image.mimeType]) throw new Error(`Unsupported image type: ${image.mimeType}`);
		const buffer = toBuffer(image.data);
		if (buffer.byteLength > this.config.maxImageBytes) {
			throw new Error(`Image exceeds the ${Math.round(this.config.maxImageBytes / 1024 / 1024)} MiB limit`);
		}
		const id = `sha256:${sha256(buffer)}`;
		const path = artifactPath(this.paths, id, image.mimeType);
		const metadataPath = `${path}.json`;
		try {
			return JSON.parse(await readFile(metadataPath, "utf8")) as Artifact;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const metadata = await sharp(buffer, { limitInputPixels: this.config.maxPixels }).metadata();
		const width = metadata.width ?? 0;
		const height = metadata.height ?? 0;
		if (!width || !height || width * height > this.config.maxPixels) {
			throw new Error("Image dimensions exceed the configured pixel limit");
		}
		await mkdir(join(this.paths.cacheDir, "artifacts"), { recursive: true, mode: 0o700 });
		await writeFile(path, buffer, { mode: 0o600 });
		const artifact: Artifact = {
			id,
			path,
			mimeType: image.mimeType,
			bytes: buffer.byteLength,
			width,
			height,
			createdAt: new Date().toISOString(),
		};
		await writeFile(metadataPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
		return artifact;
	}

	async get(id: string): Promise<Artifact> {
		assertArtifactId(id);
		const directory = join(this.paths.cacheDir, "artifacts");
		const files = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
		const metadataName = files.find((file) => file.startsWith(id.slice("sha256:".length)) && file.endsWith(".json"));
		if (!metadataName) throw new Error(`Image artifact not found: ${id}`);
		const artifact = JSON.parse(await readFile(join(directory, metadataName), "utf8")) as Artifact;
		const allowedRoot = `${resolve(directory)}${process.platform === "win32" ? "\\" : "/"}`;
		if (!resolve(artifact.path).startsWith(allowedRoot)) throw new Error("Artifact path is outside the vision cache");
		try {
			await stat(artifact.path);
		} catch {
			throw new Error(`Image artifact data is missing: ${id}`);
		}
		return artifact;
	}

	async resolveReference(reference: string, current: ArtifactReference[] = []): Promise<Artifact> {
		const raw = reference.trim().replace(/^["'`]+|["'`]+$/gu, "");
		const prefixed = raw.match(/sha256:[a-f0-9]{64}/iu)?.[0]?.toLowerCase();
		if (prefixed) return this.get(prefixed);
		const digest = raw.match(/(?:^|[^a-f0-9])([a-f0-9]{64})(?:$|[^a-f0-9])/iu)?.[1]?.toLowerCase();
		if (digest) return this.get(`sha256:${digest}`);

		const normalized = raw.toLowerCase();
		for (const [index, entry] of current.entries()) {
			const aliases = new Set([
				`image ${index + 1}`,
				`image_${index + 1}`,
				`image-${index + 1}`,
				String(index + 1),
			]);
			if (entry.label) {
				aliases.add(entry.label.toLowerCase());
				aliases.add(basename(entry.label).toLowerCase());
			}
			if (aliases.has(normalized)) return this.get(entry.artifact.id);
		}
		// With one attachment there is no ambiguity, so tolerate malformed model
		// arguments such as a filename Pi did not preserve or a truncated digest.
		if (current.length === 1) return this.get(current[0].artifact.id);

		const valid = current.map((entry) => entry.artifact.id).join(", ");
		throw new Error(
			valid
				? `Unknown image artifact reference. Valid artifact_id values for this turn: ${valid}`
				: "Unknown image artifact reference. Copy the exact artifact_id value beginning with sha256: from the Pi Vision Bridge attachment manifest.",
		);
	}

	async crop(id: string, bbox: [number, number, number, number]): Promise<Artifact> {
		const artifact = await this.get(id);
		const [x1, y1, x2, y2] = bbox;
		if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 > 1000 || y2 > 1000) {
			throw new Error("Region must be normalized coordinates within 0..1000");
		}
		const left = Math.floor((x1 / 1000) * artifact.width);
		const top = Math.floor((y1 / 1000) * artifact.height);
		const width = Math.max(1, Math.min(artifact.width - left, Math.floor(((x2 - x1) / 1000) * artifact.width)));
		const height = Math.max(1, Math.min(artifact.height - top, Math.floor(((y2 - y1) / 1000) * artifact.height)));
		const cropped = await sharp(artifact.path).extract({ left, top, width, height }).toBuffer();
		return this.ingestImage({ type: "image", data: cropped.toString("base64"), mimeType: artifact.mimeType });
	}

	async listArtifacts(): Promise<Artifact[]> {
		const directory = join(this.paths.cacheDir, "artifacts");
		const files = await import("node:fs/promises").then(({ readdir }) => readdir(directory).catch(() => [] as string[]));
		const artifacts: Artifact[] = [];
		for (const file of files.filter((entry) => entry.endsWith(".json"))) {
			try {
				artifacts.push(JSON.parse(await readFile(join(directory, file), "utf8")) as Artifact);
			} catch {
				// Ignore a partial cache entry; it will be replaced on the next ingest.
			}
		}
		return artifacts;
	}
}

export async function readArtifactData(artifact: Artifact): Promise<ImageContent> {
	return {
		type: "image",
		data: (await readFile(artifact.path)).toString("base64"),
		mimeType: artifact.mimeType,
	};
}

export async function artifactSize(artifact: Artifact): Promise<number> {
	return (await stat(artifact.path)).size;
}

export function artifactFilename(artifact: Artifact): string {
	return basename(artifact.path);
}
