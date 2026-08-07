import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { removeImagePathMarkers, scanLocalImageAttachments } from "../src/image-paths.js";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

const LIMITS = { maxImages: 8, maxImageBytes: 1024 * 1024, maxPixels: 1_000_000 };

describe("local image path recovery", () => {
	it("recovers macOS clipboard paths and quoted paths with spaces", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-path-"));
		const simple = join(root, "clipboard.png");
		const spaced = join(root, "design reference.png");
		await Promise.all([writeFile(simple, PNG_1X1), writeFile(spaced, PNG_1X1)]);
		const scan = await scanLocalImageAttachments(`${simple} and "${spaced}" please inspect`, root, LIMITS);
		assert.equal(scan.attachments.length, 2);
		assert.equal(scan.attachments.every((entry) => entry.image.mimeType === "image/png"), true);
		assert.equal(removeImagePathMarkers(`${simple} inspect`, scan.attachments).includes(root), false);
		const chinese = await scanLocalImageAttachments(`本地图片路径：${simple} 。请检查`, root, LIMITS);
		assert.equal(chinese.attachments.length, 1);
		assert.deepEqual(chinese.unresolved, []);
	});

	it("resolves Pi @ references relative to the current working directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-at-"));
		await writeFile(join(root, "reference.jpg"), PNG_1X1);
		const scan = await scanLocalImageAttachments("@reference.jpg 你能看到图片吗", root, LIMITS);
		assert.equal(scan.attachments.length, 1);
		assert.equal(scan.attachments[0]?.displayName, "reference.jpg");
		assert.equal(scan.attachments[0]?.image.mimeType, "image/png");
	});

	it("reports missing local files but ignores remote image URLs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-missing-"));
		const scan = await scanLocalImageAttachments("@missing.png https://example.test/remote.png", root, LIMITS);
		assert.deepEqual(scan.attachments, []);
		assert.deepEqual(scan.unresolved, ["missing.png"]);
	});
});
