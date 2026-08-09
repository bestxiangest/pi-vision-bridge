import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RequestQueue } from "../src/request-queue.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("request queue", () => {
	it("runs requests concurrently up to the configured limit", async () => {
		const queue = new RequestQueue(4);
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			Array.from({ length: 8 }, () =>
				queue.run(async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await delay(10);
					active -= 1;
				}),
			),
		);

		assert.equal(maxActive, 4);
		assert.equal(queue.activeCount, 0);
		assert.equal(queue.pendingCount, 0);
	});

	it("continues with the next request after a failure", async () => {
		const queue = new RequestQueue(1);
		let active = 0;
		let maxActive = 0;
		const first = queue.run(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await delay(5);
			active -= 1;
			throw new Error("provider failed");
		});
		const second = queue.run(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await delay(5);
			active -= 1;
			return "ok";
		});

		await assert.rejects(first, /provider failed/);
		assert.equal(await second, "ok");
		assert.equal(maxActive, 1);
		assert.equal(queue.activeCount, 0);
	});

	it("cancels a request while it is waiting", async () => {
		const queue = new RequestQueue(1);
		let releaseFirst!: () => void;
		const first = queue.run(
			() => new Promise<void>((resolve) => {
				releaseFirst = resolve;
			}),
		);
		const controller = new AbortController();
		const second = queue.run(async () => "should not run", controller.signal);
		controller.abort();
		await assert.rejects(second, (error: unknown) => error instanceof Error && error.name === "AbortError");
		releaseFirst();
		await first;
		assert.equal(queue.activeCount, 0);
	});
});
