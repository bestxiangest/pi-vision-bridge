import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	appendAuditEntry,
	auditLogSize,
	clearAuditEntries,
	countAuditEntries,
	resolveAuditPath,
	tailAuditEntries,
	truncateError,
	_auditFilesForTest,
	_wipeAuditForTest,
	_writeAuditForTest,
} from "../src/audit.js";
import { getConfigPaths } from "../src/config.js";

function testPaths(): ReturnType<typeof getConfigPaths> {
	const root = mkdtempSync(join(tmpdir(), "pi-vision-audit-"));
	return getConfigPaths(root, ".pi", { PI_CODING_AGENT_DIR: join(root, "global") });
}

const ARTIFACT_IDS = ["sha256:abc", "sha256:def"];

describe("audit log", () => {
	it("appends JSONL entries and tails the most recent ones", async () => {
		const paths = testPaths();
		for (let index = 0; index < 15; index += 1) {
			await appendAuditEntry(paths, {
				ts: `2026-08-08T00:00:${String(index).padStart(2, "0")}Z`,
				outcome: "success",
				model: "vision-model",
				mode: "ui_geometry",
				imageCount: 1,
				artifactIds: ARTIFACT_IDS,
				elapsedMs: 123,
			});
		}
		assert.equal(await countAuditEntries(paths), 15);
		const tail = await tailAuditEntries(paths, 5);
		assert.equal(tail.length, 5);
		assert.equal(tail[0]?.ts, "2026-08-08T00:00:10Z");
		assert.equal(tail[4]?.ts, "2026-08-08T00:00:14Z");
		assert.ok((await auditLogSize(paths)) > 0);
		assert.equal((await _auditFilesForTest(paths)).includes("audit.log"), true);
	});

	it("records failure entries with truncated errors", async () => {
		const paths = testPaths();
		await appendAuditEntry(paths, {
			ts: "2026-08-08T00:00:00Z",
			outcome: "failure",
			model: "vision-model",
			mode: "ocr",
			imageCount: 1,
			artifactIds: ARTIFACT_IDS,
			elapsedMs: 5,
			error: truncateError(new Error("x".repeat(500))),
		});
		const entries = await tailAuditEntries(paths, 1);
		assert.equal(entries[0]?.outcome, "failure");
		assert.equal((entries[0]?.error ?? "").length, 301);
	});

	it("returns empty results when the log does not exist", async () => {
		const paths = testPaths();
		assert.equal(await countAuditEntries(paths), 0);
		assert.deepEqual(await tailAuditEntries(paths, 10), []);
		assert.equal(await auditLogSize(paths), 0);
	});

	it("clears the log while keeping the file", async () => {
		const paths = testPaths();
		await appendAuditEntry(paths, {
			ts: "2026-08-08T00:00:00Z",
			outcome: "cache",
			model: "vision-model",
			mode: "general",
			imageCount: 1,
			artifactIds: ARTIFACT_IDS,
			elapsedMs: 0,
		});
		await clearAuditEntries(paths);
		assert.equal(await countAuditEntries(paths), 0);
		assert.equal((await _auditFilesForTest(paths)).includes("audit.log"), true);
	});

	it("skips malformed lines when tailing", async () => {
		const paths = testPaths();
		await _writeAuditForTest(paths, "not-json\n");
		await appendAuditEntry(paths, {
			ts: "2026-08-08T00:00:00Z",
			outcome: "success",
			model: "vision-model",
			mode: "general",
			imageCount: 1,
			artifactIds: ARTIFACT_IDS,
			elapsedMs: 0,
		});
		const entries = await tailAuditEntries(paths, 10);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.outcome, "success");
		assert.equal(await countAuditEntries(paths), 2);
		await _wipeAuditForTest(paths);
	});
});
