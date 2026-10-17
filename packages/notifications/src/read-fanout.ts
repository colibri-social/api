import type { ReadPushTarget } from "./push.js";

export const READ_FANOUT_DELAY_MS = 1_000;
const REMEMBERED_LIMIT = 10_000;

export type ReadFanoutOptions = {
	deliver: (did: string, target: ReadPushTarget) => Promise<void>;
	delayMs?: number;
	onError?: (error: unknown) => void;
};

export type ReadFanout = {
	schedule: (did: string, target: ReadPushTarget) => void;
	flush: () => Promise<void>;
	close: () => void;
};

type Pending = { did: string; target: ReadPushTarget; timer: ReturnType<typeof setTimeout> };

export const createReadFanout = (options: ReadFanoutOptions): ReadFanout => {
	const delayMs = options.delayMs ?? READ_FANOUT_DELAY_MS;
	const pending = new Map<string, Pending>();
	const sent = new Map<string, string>();
	const running = new Set<Promise<void>>();

	const remember = (key: string, through: string): void => {
		sent.delete(key);
		sent.set(key, through);
		if (sent.size <= REMEMBERED_LIMIT) return;
		const oldest = sent.keys().next().value;
		if (oldest !== undefined) sent.delete(oldest);
	};

	const fire = (key: string): void => {
		const entry = pending.get(key);
		if (!entry) return;
		pending.delete(key);
		clearTimeout(entry.timer);
		const last = sent.get(key);
		if (last !== undefined && entry.target.through <= last) return;
		remember(key, entry.target.through);
		const run = options
			.deliver(entry.did, entry.target)
			.catch((error: unknown) => options.onError?.(error))
			.finally(() => running.delete(run));
		running.add(run);
	};

	return {
		schedule: (did, target) => {
			const key = `${did} ${target.thread ?? target.channel}`;
			const last = sent.get(key);
			if (last !== undefined && target.through <= last) return;
			const existing = pending.get(key);
			if (existing) clearTimeout(existing.timer);
			const through =
				existing && existing.target.through > target.through
					? existing.target.through
					: target.through;
			const timer = setTimeout(() => fire(key), delayMs);
			timer.unref?.();
			pending.set(key, { did, target: { ...target, through }, timer });
		},
		flush: async () => {
			for (const key of [...pending.keys()]) fire(key);
			await Promise.all([...running]);
		},
		close: () => {
			for (const entry of pending.values()) clearTimeout(entry.timer);
			pending.clear();
		},
	};
};
