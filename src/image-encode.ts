import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Shrinks the copy of an image that is uploaded to the vision endpoint. Local
 * artifacts keep the original bytes for crops and preview; only the remote
 * payload is resized so multi-megabyte photos and 4K screenshots do not
 * dominate upload and provider-side processing time. Any encode failure falls
 * back to the original bytes so re-encoding can never break a vision call.
 */
export interface UploadEncodeLimits {
	/** Longest allowed image edge in pixels. */
	maxEdgePx: number;
	/** Re-encode to JPEG when the resized copy still exceeds this many bytes. */
	maxBytes: number;
}

export async function encodeImageForUpload(image: ImageContent, limits: UploadEncodeLimits): Promise<ImageContent> {
	if (image.mimeType === "image/gif") return image; // Animated; re-encoding would drop frames.
	try {
		const input = Buffer.from(image.data, "base64");
		const metadata = await sharp(input).metadata();
		const width = metadata.width ?? 0;
		const height = metadata.height ?? 0;
		if (!width || !height) return image;
		let output = input;
		let mimeType = image.mimeType;
		if (Math.max(width, height) > limits.maxEdgePx) {
			const pipeline = sharp(input)
				.rotate()
				.resize({ width: limits.maxEdgePx, height: limits.maxEdgePx, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
			output =
				metadata.format === "png"
					? await pipeline.png().toBuffer()
					: metadata.format === "webp"
						? await pipeline.webp({ quality: 90 }).toBuffer()
						: await pipeline.jpeg({ quality: 90 }).toBuffer();
		}
		if (output.byteLength > limits.maxBytes) {
			const jpeg = await sharp(output).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
			if (jpeg.byteLength < output.byteLength) {
				output = jpeg;
				mimeType = "image/jpeg";
			}
		}
		if (output === input) return image;
		return { type: "image", data: output.toString("base64"), mimeType };
	} catch {
		return image;
	}
}
