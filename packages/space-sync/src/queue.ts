export type QueueOptions = {
	concurrency: number;
	onError?: (key: string, error: unknown) => void;
};

export type QueueStats = {
	pending: number;
	running: number;
};

export class KeyedWorkQueue {
	private readonly waiting: string[] = [];
	private readonly queued = new Set<string>();
	private readonly running = new Set<string>();
	private readonly idleWaiters: Array<() => void> = [];
	private draining = false;
	private stopped = false;

	constructor(
		private readonly run: (key: string) => Promise<void>,
		private readonly options: QueueOptions,
	) {}

	get stats(): QueueStats {
		return { pending: this.waiting.length, running: this.running.size };
	}

	push(key: string): void {
		if (this.stopped) return;
		if (this.queued.has(key) || this.running.has(key)) return;
		this.queued.add(key);
		this.waiting.push(key);
		this.drain();
	}

	pushAll(keys: Iterable<string>): void {
		for (const key of keys) this.push(key);
	}

	async onIdle(): Promise<void> {
		if (this.isIdle()) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	stop(): void {
		this.stopped = true;
		this.waiting.length = 0;
		this.queued.clear();
		this.settleIfIdle();
	}

	private isIdle(): boolean {
		return this.waiting.length === 0 && this.running.size === 0;
	}

	private settleIfIdle(): void {
		if (!this.isIdle()) return;
		while (this.idleWaiters.length) this.idleWaiters.pop()?.();
	}

	private drain(): void {
		if (this.draining) return;
		this.draining = true;
		queueMicrotask(() => {
			this.draining = false;
			this.fill();
		});
	}

	private fill(): void {
		while (this.running.size < this.options.concurrency && this.waiting.length > 0) {
			const key = this.waiting.shift() as string;
			this.queued.delete(key);
			this.running.add(key);
			void this.execute(key);
		}
		this.settleIfIdle();
	}

	private async execute(key: string): Promise<void> {
		try {
			await this.run(key);
		} catch (error) {
			this.options.onError?.(key, error);
		} finally {
			this.running.delete(key);
			this.fill();
		}
	}
}
