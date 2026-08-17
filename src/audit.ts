import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConfigPaths } from "./config.js";

/**
 * Append-only JSONL audit log of every vision delegation. Answers "where did
 * each image go and what happened?" without storing image bytes, prompts, or
 * credentials. One JSON object per line at
 * `~/.pi/agent/vision-bridge/audit.log`.
 */

export type AuditOutcome = "success" | "cache" | "fallback" | "failure";

export interface AuditEntry {
	ts: string;
	outcome: AuditOutcome;
	model: string;
	mode: string;
	imageCount: number;
	artifactIds: string[];
	elapsedMs: number;
	/** True when two parallel requests raced and the first valid JSON won. */
	hedged?: boolean;
	/** Truncated error message for "failure" entries. */
	error?: string;
}

const AUDIT_FILE = "audit.log";
const MAX_ERROR_CHARS = 300;

export function resolveAuditPath(paths: ConfigPaths): string {
	return join(paths.globalDir, AUDIT_FILE);
}

export async function appendAuditEntry(paths: ConfigPaths, entry: AuditEntry): Promise<void> {
	const path = resolveAuditPath(paths);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const line = `${JSON.stringify(entry)}\n`;
	await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
}

export function truncateError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

export async function countAuditEntries(paths: ConfigPaths): Promise<number> {
	try {
		const content = await readFile(resolveAuditPath(paths), "utf8");
		return content.split("\n").filter((line) => line.trim().length > 0).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** Returns the last `limit` entries, oldest first. */
export async function tailAuditEntries(paths: ConfigPaths, limit = 10): Promise<AuditEntry[]> {
	try {
		const content = await readFile(resolveAuditPath(paths), "utf8");
		const lines = content.split("\n").filter((line) => line.trim().length > 0);
		const entries: AuditEntry[] = [];
		for (const line of lines.slice(-limit)) {
			try {
				entries.push(JSON.parse(line) as AuditEntry);
			} catch {
				// Skip malformed lines without failing the whole tail.
			}
		}
		return entries;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function clearAuditEntries(paths: ConfigPaths): Promise<void> {
	const path = resolveAuditPath(paths);
	try {
		await stat(path);
		await truncate(path, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export async function auditLogSize(paths: ConfigPaths): Promise<number> {
	try {
		const content = await readFile(resolveAuditPath(paths), "utf8");
		return Buffer.byteLength(content, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** Internal: list files in the audit dir (used only by tests). */
export async function _auditFilesForTest(paths: ConfigPaths): Promise<string[]> {
	return readdir(paths.globalDir).catch(() => [] as string[]);
}

/** Internal: wipe the audit log entirely (used only by tests). */
export async function _wipeAuditForTest(paths: ConfigPaths): Promise<void> {
	await rm(resolveAuditPath(paths), { force: true });
}

/** Internal: rewrite the audit log with raw content (used only by tests). */
export async function _writeAuditForTest(paths: ConfigPaths, content: string): Promise<void> {
	const path = resolveAuditPath(paths);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}
