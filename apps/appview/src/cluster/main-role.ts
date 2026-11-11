import { type AdvisoryLock, holdLock, type LockHolder } from "@colibri-social/appview-db";
import type { Logger } from "../logger.js";

export const HANDOVER_TIMEOUT_MS = 60_000;

export type MainRoleDeps = {
	lock: () => AdvisoryLock;
	canContend: () => boolean;
	mayAcquire?: () => Promise<boolean>;
	invite?: (target: string) => void;
	mainNode: () => Promise<string | null>;
	onAcquired: () => Promise<void>;
	onReleasing: () => Promise<void>;
	onLost: (error: unknown) => void;
	log: Pick<Logger, "info" | "warn">;
	retryMs?: number;
	pollMs?: number;
	timeoutMs?: number;
};

export type MainRole = {
	readonly held: boolean;
	contend: () => void;
	pause: () => Promise<void>;
	yieldTo: (target: string) => Promise<boolean>;
	stop: () => Promise<void>;
};

export const createMainRole = (deps: MainRoleDeps): MainRole => {
	let holder: LockHolder | null = null;
	let held = false;
	let yielding = false;
	let stopped = false;

	const release = async (): Promise<void> => {
		const current = holder;

		holder = null;

		if (held) {
			held = false;
			await deps.onReleasing().catch((error: unknown) => {
				deps.log.warn({ err: error }, "main.releaseFailed");
			});
		}

		await current?.stop().catch(() => undefined);
	};

	const contend = (): void => {
		if (holder || stopped || yielding || !deps.canContend()) {
			return;
		}

		const lock = deps.lock();
		const mayAcquire = deps.mayAcquire;

		holder = holdLock({
			lock: mayAcquire
				? {
						get held() {
							return lock.held;
						},
						tryAcquire: async () => (await mayAcquire().catch(() => false)) && lock.tryAcquire(),
						release: () => lock.release(),
						onLost: (listener) => lock.onLost(listener),
					}
				: lock,
			...(deps.retryMs === undefined ? {} : { retryMs: deps.retryMs }),
			onAcquired: async () => {
				held = true;
				deps.log.info("main.acquired");
				await deps.onAcquired();
			},
			onLost: (error) => {
				held = false;
				deps.onLost(error);
			},
			onRetryFailed: (error) => {
				deps.log.warn({ err: error }, "main.acquireFailed");
			},
		});
	};

	return {
		get held() {
			return held;
		},
		contend,
		pause: async () => {
			if (!held) {
				await release();
			}
		},
		yieldTo: async (target) => {
			if (!held || yielding || stopped) {
				return false;
			}

			yielding = true;
			deps.log.info({ target }, "main.yielding");

			try {
				deps.invite?.(target);
				await release();

				const deadline = Date.now() + (deps.timeoutMs ?? HANDOVER_TIMEOUT_MS);

				while (Date.now() < deadline) {
					if ((await deps.mainNode().catch(() => null)) === target) {
						deps.log.info({ target }, "main.handedOver");

						return true;
					}

					await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 1_000));
				}

				deps.log.warn({ target }, "main.handoverTimedOut");

				return false;
			} finally {
				yielding = false;
				contend();
			}
		},
		stop: async () => {
			stopped = true;
			await release();
		},
	};
};
