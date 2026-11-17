import { PEER_HEARTBEAT_WINDOW_MS } from "../drain.js";
import type { Logger } from "../logger.js";
import type { Alive } from "./protocol.js";
import type { NodeRow, Registry } from "./registry.js";

export const HAND_BACK_AFTER_MS = 2 * 60_000;

export const UNCLAIMED_MS = 30_000;

export type DeferState = { unclaimedSince: number | null };

export type HandoverOutcome =
	| "none"
	| "busy"
	| "holdingPrimary"
	| "waiting"
	| "handedBack"
	| "failed";

export type HandoverDeps = {
	registry: Pick<Registry, "list">;
	self: string;
	version: string;
	yieldMain: (target: string) => Promise<boolean>;
	busy: () => boolean;
	holdsPrimary?: () => Promise<boolean>;
	log: Pick<Logger, "info" | "warn">;
	now?: () => number;
	stableMs?: number;
};

export type Handover = {
	tick: () => Promise<HandoverOutcome>;
};

type ParsedVersion = { core: number[]; prerelease: string[] };

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const parseVersion = (version: string): ParsedVersion | null => {
	const match = VERSION_PATTERN.exec(version);

	if (!match) {
		return null;
	}

	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4]?.split(".") ?? [],
	};
};

const compareIdentifiers = (a: string, b: string): number => {
	const numericA = /^\d+$/.test(a);
	const numericB = /^\d+$/.test(b);

	if (numericA && numericB) {
		return Number(a) - Number(b);
	}

	if (numericA !== numericB) {
		return numericA ? -1 : 1;
	}

	return a < b ? -1 : a > b ? 1 : 0;
};

const comparePrerelease = (a: string[], b: string[]): number => {
	if (a.length === 0 || b.length === 0) {
		return b.length - a.length;
	}

	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const order = compareIdentifiers(a[index] ?? "", b[index] ?? "");

		if (order !== 0) {
			return order;
		}
	}

	return a.length - b.length;
};

export const compareVersions = (a: string, b: string): number | null => {
	const left = parseVersion(a);
	const right = parseVersion(b);

	if (!left || !right) {
		return null;
	}

	for (let index = 0; index < 3; index += 1) {
		const order = (left.core[index] ?? 0) - (right.core[index] ?? 0);

		if (order !== 0) {
			return Math.sign(order);
		}
	}

	return Math.sign(comparePrerelease(left.prerelease, right.prerelease));
};

export const sameOrNewer = (version: string, base: string): boolean => {
	return version === base || (compareVersions(version, base) ?? -1) >= 0;
};

const live = (node: NodeRow, now: number): boolean => {
	return (
		node.state === "active" &&
		node.heartbeatAt !== null &&
		new Date(node.heartbeatAt).getTime() > now - PEER_HEARTBEAT_WINDOW_MS
	);
};

export const ready = (node: NodeRow, version: string, now: number): boolean => {
	return live(node, now) && node.version === version;
};

export const readyOnOrAfter = (node: NodeRow, version: string, now: number): boolean => {
	return live(node, now) && sameOrNewer(node.version, version);
};

export const takeoverCandidate = (
	nodes: readonly NodeRow[],
	self: string,
	version: string,
	now: number,
): NodeRow | null => {
	const capable = nodes.filter(
		(node) =>
			node.id !== self &&
			(node.roles.includes("main") || node.roles.includes("failover")) &&
			ready(node, version, now),
	);

	return (
		capable.find((node) => node.roles.includes("main")) ??
		capable.sort((a, b) => a.id.localeCompare(b.id))[0] ??
		null
	);
};

export const shouldDefer = (
	answers: readonly (Alive | null)[],
	state: DeferState,
	now: number,
): boolean => {
	const up = answers.filter((answer): answer is Alive => answer !== null && !answer.draining);

	if (up.length === 0 || up.some((answer) => answer.main)) {
		state.unclaimedSince = null;

		return up.length > 0;
	}

	state.unclaimedSince ??= now;

	return now - state.unclaimedSince < UNCLAIMED_MS;
};

export const createHandover = (deps: HandoverDeps): Handover => {
	const now = deps.now ?? Date.now;
	let candidate: { id: string; since: number } | null = null;

	return {
		tick: async () => {
			if (deps.busy()) {
				return "busy";
			}

			if (await (deps.holdsPrimary?.() ?? Promise.resolve(false)).catch(() => false)) {
				return "holdingPrimary";
			}

			const at = now();
			const preferred = (await deps.registry.list()).find(
				(node) =>
					node.id !== deps.self &&
					node.roles.includes("main") &&
					readyOnOrAfter(node, deps.version, at),
			);

			if (!preferred) {
				candidate = null;

				return "none";
			}

			if (candidate?.id !== preferred.id) {
				candidate = { id: preferred.id, since: at };

				return "waiting";
			}

			if (at - candidate.since < (deps.stableMs ?? HAND_BACK_AFTER_MS)) {
				return "waiting";
			}

			candidate = null;
			deps.log.info({ target: preferred.id }, "main.handingBack");

			if (await deps.yieldMain(preferred.id)) {
				return "handedBack";
			}

			deps.log.warn({ target: preferred.id }, "main.handBackFailed");

			return "failed";
		},
	};
};
