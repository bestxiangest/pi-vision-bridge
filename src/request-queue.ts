interface QueueEntry<T> {
	task: () => Promise<T>;
	signal?: AbortSignal;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	onAbort?: () => void;
}

function createAbortError(): Error {
	const error = new Error("Vision request aborted");
	error.name = "AbortError";
	return error;
}

/** FIFO limiter for provider requests. Queued calls can be cancelled before they start. */
export class RequestQueue {
	private active = 0;
	private readonly pending: Array<QueueEntry<unknown>> = [];

	constructor(private readonly maxConcurrent: number) {
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
	}

	get activeCount(): number {
		return this.active;
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(createAbortError());
		return new Promise<T>((resolve, reject) => {
			const entry: QueueEntry<T> = { task, signal, resolve, reject };
			entry.onAbort = () => {
				const index = this.pending.indexOf(entry as QueueEntry<unknown>);
				if (index < 0) return;
				this.pending.splice(index, 1);
				signal?.removeEventListener("abort", entry.onAbort!);
				reject(createAbortError());
			};
			signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.pending.push(entry as QueueEntry<unknown>);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.maxConcurrent && this.pending.length > 0) {
			const entry = this.pending.shift()!;
			entry.signal?.removeEventListener("abort", entry.onAbort!);
			if (entry.signal?.aborted) {
				entry.reject(createAbortError());
				continue;
			}
			this.active += 1;
			void Promise.resolve()
				.then(entry.task)
				.then(
					(value) => {
						this.active -= 1;
						this.drain();
						entry.resolve(value);
					},
					(error) => {
						this.active -= 1;
						this.drain();
						entry.reject(error);
					},
				);
		}
	}
}
