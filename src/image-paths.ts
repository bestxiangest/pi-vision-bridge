import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";

const EXTENSION_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/png",
	".tif": "image/png",
	".tiff": "image/png",
};

const FORMAT_MIME: Record<string, string> = {
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
};

const IMAGE_SUFFIX = /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/iu;

export interface LocalImageAttachment {
	path: string;
	source: string;
	displayName: string;
	image: ImageContent;
}

export interface LocalImageScan {
	attachments: LocalImageAttachment[];
	unresolved: string[];
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
		return trimmed.slice(1, -1).replace(/\\([\\"'])/g, "$1");
	}
	return trimmed;
}

function cleanCandidate(value: string): string {
	return unquote(value).replace(/^@(?=~?\/|\.?\/|[A-Za-z0-9_\-])/u, "").replace(/[),.;:!?]+$/u, "");
}

function candidateTokens(text: string): string[] {
	const candidates = new Set<string>();
	const addCandidate = (value: string): void => {
		if (/^(?:https?|data):/iu.test(value)) return;
		if (IMAGE_SUFFIX.test(value)) candidates.add(value);
	};
	const quoted = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu;
	for (const match of text.matchAll(quoted)) {
		const value = cleanCandidate(match[1] ?? "");
		addCandidate(value);
	}
	const unquoted = /(?:^|[\s(：:])(@?(?:(?:~\/|\/|\.{1,2}\/)[^\s"'<>]+|[A-Za-z0-9_.-][^\s"'<>]*)\.(?:png|jpe?g|webp|gif|bmp|tiff?))(?!\S)/giu;
	for (const match of text.matchAll(unquoted)) {
		const value = cleanCandidate(match[1] ?? "");
		addCandidate(value);
	}
	return [...candidates];
}

function resolveCandidate(value: string, cwd: string): string {
	const withoutMarker = value.replace(/^@/u, "");
	const expanded = withoutMarker === "~" || withoutMarker.startsWith("~/") ? joinHome(withoutMarker) : withoutMarker;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function joinHome(value: string): string {
	return value === "~" ? homedir() : `${homedir()}${value.slice(1)}`;
}

async function readImage(path: string, limits: { maxImageBytes: number; maxPixels: number }): Promise<ImageContent> {
	const file = await stat(path);
	if (!file.isFile()) throw new Error("not a file");
	if (file.size > limits.maxImageBytes) throw new Error("image exceeds byte limit");
	const buffer = await readFile(path);
	const metadata = await sharp(buffer, { limitInputPixels: limits.maxPixels }).metadata();
	if (!metadata.width || !metadata.height || metadata.width * metadata.height > limits.maxPixels) throw new Error("image exceeds pixel limit");
	const format = metadata.format?.toLowerCase();
	const extensionMime = EXTENSION_MIME[extname(path).toLowerCase()];
	const actualMime = format ? FORMAT_MIME[format] : undefined;
	const mimeType = actualMime ?? extensionMime;
	if (!mimeType) throw new Error("unsupported image format");
	const needsPng = !actualMime && ["bmp", "tiff"].includes(format ?? "");
	const normalized = needsPng ? await sharp(buffer).png().toBuffer() : buffer;
	return { type: "image", data: normalized.toString("base64"), mimeType: needsPng ? "image/png" : mimeType };
}

/**
 * Recover local image attachments from Pi's path-based clipboard/drop fallback.
 * Only existing local image files are read; URLs and arbitrary prose are ignored.
 */
export async function scanLocalImageAttachments(
	text: string,
	cwd: string,
	limits: { maxImages: number; maxImageBytes: number; maxPixels: number },
): Promise<LocalImageScan> {
	const candidates = candidateTokens(text).slice(0, Math.max(0, limits.maxImages));
	const attachments: LocalImageAttachment[] = [];
	const unresolved: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const path = resolveCandidate(candidate, cwd);
		if (seen.has(path)) continue;
		seen.add(path);
		try {
			const image = await readImage(path, limits);
			attachments.push({ path, source: candidate, displayName: basename(path), image });
		} catch {
			unresolved.push(candidate);
		}
	}
	return { attachments, unresolved };
}

export function removeImagePathMarkers(text: string, attachments: LocalImageAttachment[]): string {
	let result = text;
	for (const attachment of attachments) {
		const source = attachment.source.replace(/^@/u, "");
		const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(`@?${escaped}`, "gu"), attachment.displayName);
	}
	return result;
}
