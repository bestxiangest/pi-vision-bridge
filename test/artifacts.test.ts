import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ArtifactStore } from "../src/artifacts.js";
import { DEFAULT_CONFIG, getConfigPaths } from "../src/config.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("artifact store", () => {
	it("stores, reopens, and crops image artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-artifact-"));
		const paths = getConfigPaths(root, ".pi", { PI_CODING_AGENT_DIR: join(root, "global") });
		const store = new ArtifactStore(paths, { ...DEFAULT_CONFIG, maxPixels: 100 });
		const artifact = await store.ingestImage({ type: "image", data: PNG_1X1, mimeType: "image/png" });
		assert.match(artifact.id, /^sha256:[a-f0-9]{64}$/);
		assert.equal((await store.get(artifact.id)).width, 1);
		const cropped = await store.crop(artifact.id, [0, 0, 1000, 1000]);
		assert.equal(cropped.width, 1);
		assert.equal((await readFile(cropped.path)).byteLength > 0, true);
	});

	it("rejects unsupported image types", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-artifact-"));
		const paths = getConfigPaths(root, ".pi", { PI_CODING_AGENT_DIR: join(root, "global") });
		const store = new ArtifactStore(paths, DEFAULT_CONFIG);
		await assert.rejects(() => store.ingestImage({ type: "image", data: PNG_1X1, mimeType: "image/svg+xml" }), /Unsupported image type/);
	});

	it("resolves canonical ids and current-turn compatibility aliases", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vision-reference-"));
		const paths = getConfigPaths(root, ".pi", { PI_CODING_AGENT_DIR: join(root, "global") });
		const store = new ArtifactStore(paths, DEFAULT_CONFIG);
		const artifact = await store.ingestImage({ type: "image", data: PNG_1X1, mimeType: "image/png" });
		const current = [{ artifact, label: "Bing_reference.jpg" }];
		assert.equal((await store.resolveReference(artifact.id, current)).id, artifact.id);
		assert.equal((await store.resolveReference(artifact.id.slice("sha256:".length), current)).id, artifact.id);
		assert.equal((await store.resolveReference("image 1", current)).id, artifact.id);
		assert.equal((await store.resolveReference("Bing_reference.jpg", current)).id, artifact.id);
		assert.equal((await store.resolveReference("truncated-or-unknown-reference", current)).id, artifact.id);

		const second = await store.ingestImage({ type: "image", data: `data:image/png;base64,${PNG_1X1}`, mimeType: "image/png" });
		await assert.rejects(
			() => store.resolveReference("missing.jpg", [{ artifact }, { artifact: second, label: "second.png" }]),
			/Valid artifact_id values/,
		);
	});
});
