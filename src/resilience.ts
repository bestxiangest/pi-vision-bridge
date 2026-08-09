/**
 * Resilience helpers for vision delegations: error classification and
 * abort-aware exponential-backoff retry.
 *
 * The provider layer surfaces failures as ordinary errors with a human
 * message (and sometimes a numeric status), so classification is heuristic:
 *  - abort    → the turn was cancelled; never retry.
 *  - retryable → transient server / rate-limit / network failures (429, 5xx,
 *                fetch failures, timeouts, socket errors). Safe to retry.
 *  - fatal    → request errors that will not succeed on retry (4xx, auth,
 *                invalid model, bad image).
 */

export type ErrorClass = "abort" | "retryable" | "fatal";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_MESSAGE = /(?:429|5\d\d|408|425)\b|fetch failed|network|timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|temporarily|overloaded|rate\s*limit|too many requests|internal server|bad gateway|service unavailable|gateway timeout|upstream/i;

function numericStatus(err: unknown): number | undefined {
	const status = (err as { status?: unknown }).status;
	return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export function classifyError(err: unknown, signal?: AbortSignal): ErrorClass {
	if (signal?.aborted) return "abort";
	const name = (err as Error | undefined)?.name;
	if (name === "AbortError") return "abort";
	if (name === "TimeoutError") return "retryable";
	const message = (err as Error | undefined)?.message ?? String(err);
	if (/aborted|user cancelled|canceled/i.test(message)) return "abort";
	const status = numericStatus(err);
	if (status !== undefined) return RETRYABLE_STATUS.has(status) || (status >= 500 && status <= 599) ? "retryable" : "fatal";
	return RETRYABLE_MESSAGE.test(message) ? "retryable" : "fatal";
}

export interface RetryOptions {
	/** Extra attempts after the first try. */
	maxRetries: number;
	/** Base delay in ms; each attempt doubles it (with jitter). */
	baseDelayMs?: number;
	signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("The operation was aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new DOMException("The operation was aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Runs `fn` and retries retryable failures with exponential backoff and
 * jitter. Aborts (signal or AbortError) and fatal errors propagate
 * immediately. Returns `{ value, attempts }` on success.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
	const baseDelayMs = options.baseDelayMs ?? 750;
	let attempts = 0;
	while (true) {
		attempts += 1;
		try {
			return { value: await fn(), attempts };
		} catch (error) {
			const cls = classifyError(error, options.signal);
			if (cls !== "retryable" || attempts > options.maxRetries) throw error;
			const delay = Math.min(15_000, baseDelayMs * 2 ** (attempts - 1)) * (0.5 + Math.random() * 0.5);
			await sleep(delay, options.signal);
		}
	}
}
