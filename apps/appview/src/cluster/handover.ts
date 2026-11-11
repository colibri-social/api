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

export const ready = (node: NodeRow, version: string, now: number): boolean => {
	return (
		node.state === "active" &&
		node.version === version &&
		node.heartbeatAt !== null &&
		new Date(node.heartbeatAt).getTime() > now - PEER_HEARTBEAT_WINDOW_MS
	);
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
					node.id !== deps.self && node.roles.includes("main") && ready(node, deps.version, at),
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
