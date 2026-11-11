import pg from "pg";

export type AdvisoryLock = {
	readonly held: boolean;
	tryAcquire: () => Promise<boolean>;
	release: () => Promise<void>;
	onLost: (listener: (error: unknown) => void) => () => void;
};

export type LockHolder = {
	stop: () => Promise<void>;
};

export type HoldLockOptions = {
	lock: AdvisoryLock;
	retryMs?: number;
	onAcquired: () => void | Promise<void>;
	onLost: (error: unknown) => void;
	onRetryFailed?: (error: unknown) => void;
};

export const grantedLock = (): AdvisoryLock => {
	let held = false;

	return {
		get held() {
			return held;
		},
		tryAcquire: async () => {
			held = true;

			return true;
		},
		release: async () => {
			held = false;
		},
		onLost: () => {
			return () => {};
		},
	};
};

export const postgresAdvisoryLock = (
	url: string | (() => Promise<string>),
	key: number,
): AdvisoryLock => {
	const listeners = new Set<(error: unknown) => void>();
	let client: pg.Client | null = null;
	let held = false;

	const lose = (error: unknown) => {
		if (!held) {
			return;
		}

		held = false;
		client = null;

		for (const listener of listeners) {
			listener(error);
		}
	};

	return {
		get held() {
			return held;
		},
		tryAcquire: async () => {
			if (held) {
				return true;
			}

			const candidate = new pg.Client({
				connectionString: typeof url === "string" ? url : await url(),
			});

			await candidate.connect();

			try {
				const result = await candidate.query<{ locked: boolean }>(
					"select pg_try_advisory_lock($1) as locked",
					[key],
				);

				if (!result.rows[0]?.locked) {
					await candidate.end();

					return false;
				}
			} catch (error) {
				await candidate.end().catch(() => {});

				throw error;
			}

			candidate.on("error", (error) => lose(error));
			candidate.on("end", () => lose(new Error("lock connection closed")));
			client = candidate;
			held = true;

			return true;
		},
		release: async () => {
			const current = client;

			held = false;
			client = null;

			if (!current) {
				return;
			}

			await current.query("select pg_advisory_unlock($1)", [key]).catch(() => {});
			await current.end().catch(() => {});
		},
		onLost: (listener) => {
			listeners.add(listener);

			return () => listeners.delete(listener);
		},
	};
};

export const holdLock = ({
	lock,
	retryMs = 5_000,
	onAcquired,
	onLost,
	onRetryFailed,
}: HoldLockOptions): LockHolder => {
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;

	const unsubscribe = lock.onLost((error) => {
		if (!stopped) {
			onLost(error);
		}
	});

	const attempt = async (): Promise<void> => {
		timer = null;

		if (stopped) {
			return;
		}

		let acquired = false;

		try {
			acquired = await lock.tryAcquire();
		} catch (error) {
			onRetryFailed?.(error);
		}

		if (acquired && stopped) {
			await lock.release();

			return;
		}

		if (acquired) {
			await onAcquired();

			return;
		}

		if (!stopped) {
			timer = setTimeout(() => void attempt(), retryMs);
			timer.unref?.();
		}
	};

	void attempt();

	return {
		stop: async () => {
			stopped = true;
			unsubscribe();

			if (timer) {
				clearTimeout(timer);
			}

			await lock.release();
		},
	};
};
