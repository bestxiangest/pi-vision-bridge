import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";

import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";

import { encodeImageForUpload } from "../src/image-encode.js";

const LIMITS = { maxEdgePx: 2048, maxBytes: 1024 * 1024 };
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function toImage(data: string, mimeType: string): ImageContent {
	return { type: "image", data, mimeType };
}

async function noiseImage(width: number, height: number, mimeType = "image/png"): Promise<{ image: ImageContent; bytes: number }> {
	const png = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
	return { image: toImage(png.toString("base64"), mimeType), bytes: png.byteLength };
}

it("downscales uploads whose long edge exceeds the limit", async () => {
	const { image } = await noiseImage(3000, 2000);
	const encoded = await encodeImageForUpload(image, LIMITS);
	const metadata = await sharp(Buffer.from(encoded.data, "base64")).metadata();
	assert.equal(Math.max(metadata.width ?? 0, metadata.height ?? 0) <= LIMITS.maxEdgePx, true);
	assert.equal(metadata.width ?? 0, 2048);
});

it("re-encodes oversized uploads as jpeg and shrinks the payload", async () => {
	const { image, bytes } = await noiseImage(2000, 1400); // Long edge is within the limit, but noise PNG is multi-MB.
	const encoded = await encodeImageForUpload(image, LIMITS);
	assert.equal(encoded.mimeType, "image/jpeg");
	assert.equal(Buffer.from(encoded.data, "base64").byteLength < bytes, true);
});

it("leaves small images untouched byte for byte", async () => {
	const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).png().toBuffer();
	const image = toImage(png.toString("base64"), "image/png");
	const encoded = await encodeImageForUpload(image, LIMITS);
	assert.equal(encoded.data, image.data);
	assert.equal(encoded.mimeType, "image/png");
});

it("never re-encodes gif uploads", async () => {
	const image = toImage(GIF_1X1, "image/gif");
	assert.equal(await encodeImageForUpload(image, LIMITS), image);
});

it("falls back to the original bytes when the buffer is not decodable", async () => {
	const image = toImage(Buffer.from("not an image").toString("base64"), "image/png");
	const encoded = await encodeImageForUpload(image, LIMITS);
	assert.equal(encoded.data, image.data);
});
