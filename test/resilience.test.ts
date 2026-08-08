import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyError, withRetry } from "../src/resilience.js";

describe("resilience", () => {
	it("classifies retryable, fatal, and abort errors", () => {
		assert.equal(classifyError(new Error("HTTP 429 Too Many Requests")), "retryable");
		assert.equal(classifyError(new Error("HTTP 503 Service Unavailable")), "retryable");
		assert.equal(classifyError(new Error("fetch failed: connect ECONNREFUSED")), "retryable");
		assert.equal(classifyError(new Error("socket hang up")), "retryable");
		assert.equal(classifyError(new Error("The upstream server timed out")), "retryable");
		assert.equal(classifyError({ status: 500 }), "retryable");
		assert.equal(classifyError({ status: 429 }), "retryable");
		assert.equal(classifyError(new Error("HTTP 400 Bad Request")), "fatal");
		assert.equal(classifyError(new Error("HTTP 401 Unauthorized")), "fatal");
		assert.equal(classifyError({ status: 404 }), "fatal");
		assert.equal(classifyError(new Error("Vision response did not contain a JSON object")), "fatal");
	});

	it("treats aborted signals and AbortError as abort", () => {
		const controller = new AbortController();
		controller.abort();
		assert.equal(classifyError(new DOMException("aborted", "AbortError")), "abort");
		assert.equal(classifyError(new Error("The operation was aborted"), controller.signal), "abort");
	});

	it("retries retryable failures with backoff until success", async () => {
		let calls = 0;
		const { value, attempts } = await withRetry(async () => {
			calls += 1;
			if (calls < 3) throw new Error("HTTP 503 Service Unavailable");
			return "ok";
		}, { maxRetries: 4, baseDelayMs: 1 });
		assert.equal(value, "ok");
		assert.equal(attempts, 3);
		assert.equal(calls, 3);
	});

	it("gives up after maxRetries and rethrows the last error", async () => {
		let calls = 0;
		await assert.rejects(
			withRetry(async () => {
				calls += 1;
				throw new Error("HTTP 503 Service Unavailable");
			}, { maxRetries: 2, baseDelayMs: 1 }),
			/503/,
		);
		assert.equal(calls, 3);
	});

	it("does not retry fatal errors", async () => {
		let calls = 0;
		await assert.rejects(
			withRetry(async () => {
				calls += 1;
				throw new Error("HTTP 401 Unauthorized");
			}, { maxRetries: 4, baseDelayMs: 1 }),
			/401/,
		);
		assert.equal(calls, 1);
	});

	it("does not retry after the signal is aborted", async () => {
		const controller = new AbortController();
		let calls = 0;
		const promise = withRetry(
			async () => {
				calls += 1;
				throw new Error("HTTP 503 Service Unavailable");
			},
			{ maxRetries: 5, baseDelayMs: 1, signal: controller.signal },
		);
		// Let the first attempt fail and the retry sleep begin.
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await assert.rejects(promise, /aborted/i);
	});
});
