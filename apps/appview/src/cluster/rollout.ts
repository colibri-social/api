import { PEER_HEARTBEAT_WINDOW_MS } from "../drain.js";
import type { Logger } from "../logger.js";
import type { AnsibleRunner, PlaybookResult } from "./ansible.js";
import { takeoverCandidate } from "./handover.js";
import type { ResolvedImage } from "./image-source.js";
import type { MainFrame } from "./protocol.js";
import type { NodeRow, Registry } from "./registry.js";

export const VERIFY_TIMEOUT_MS = 10 * 60_000;

export const DRAIN_SLACK_MS = 10 * 60_000;

export const FORCED_RETRY_MS = 10_000;

export type TickOptions = {
	graceMinutes?: number;
};

export type RolloutOutcome =
	| "busy"
	| "paused"
	| "unreachable"
	| "unversioned"
	| "current"
	| "waiting"
	| "updated"
	| "failed"
	| "restarting"
	| "handedOver";

export type RolloutDeps = {
	registry: Pick<Registry, "list" | "node" | "mayLeave" | "rolloutPaused" | "pauseRollout">;
	self: string;
	image: string;
	stackDir: string;
	drainMinutes: number;
	resolve: (image: string) => Promise<ResolvedImage>;
	ansible: AnsibleRunner;
	send: (nodeId: string, frame: MainFrame) => boolean;
	drained: (nodeId: string, timeoutMs: number) => Promise<boolean>;
	active: () => boolean;
	yieldMain?: (target: string) => Promise<boolean>;
	log: Pick<Logger, "info" | "warn" | "error">;
	pollMs?: number;
	verifyTimeoutMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

export type Rollout = {
	readonly running: boolean;
	tick: (options?: TickOptions) => Promise<RolloutOutcome>;
};

type StepResult = { ok: true } | { ok: false; waiting: true } | { ok: false; reason: string };

const tailOf = (result: PlaybookResult): string[] => {
	return result.tail.slice(-10);
};

export const rolloutOrder = (nodes: readonly NodeRow[], self: string): NodeRow[] => {
	const rank = (node: NodeRow) => {
		if (node.id === self) return 2;
		if (node.roles.includes("failover")) return 1;

		return 0;
	};

	return [...nodes].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
};

export const createRollout = (deps: RolloutDeps): Rollout => {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const pollMs = deps.pollMs ?? 5_000;
	let running = false;
	let restarting = false;
	let handedOver = false;

	const fresh = (node: NodeRow, since: number): boolean => {
		return node.heartbeatAt !== null && new Date(node.heartbeatAt).getTime() > since;
	};

	const waitForVersion = async (id: string, version: string, since: number): Promise<boolean> => {
		const deadline = now() + (deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);

		while (now() < deadline) {
			const node = await deps.registry.node(id).catch(() => null);

			if (node && node.state === "active" && node.version === version && fresh(node, since)) {
				return true;
			}

			await sleep(pollMs);
		}

		return false;
	};

	const playbook = async (
		node: NodeRow,
		vars: Record<string, unknown>,
	): Promise<PlaybookResult> => {
		return deps.ansible.run({
			playbook: "update",
			host: new URL(node.tailnetUrl).hostname,
			vars,
		});
	};

	const updateNode = async (
		node: NodeRow,
		target: ResolvedImage,
		options: TickOptions,
	): Promise<StepResult> => {
		const decision = await deps.registry.mayLeave(node.id);

		if (!decision.allowed) {
			deps.log.info({ node: node.id, reason: decision.reason }, "rollout.waitingForQuorum");

			return { ok: false, waiting: true };
		}

		const pulled = await playbook(node, { image: target.pinned, pull_only: true });

		if (!pulled.ok) {
			deps.log.error({ node: node.id, tail: tailOf(pulled) }, "rollout.pullFailed");

			return { ok: false, reason: "pulling the image failed" };
		}

		const drainFrame: MainFrame =
			options.graceMinutes === undefined
				? { t: "drain", mode: "update" }
				: { t: "drain", mode: "update", graceMinutes: options.graceMinutes };

		if (!deps.send(node.id, drainFrame)) {
			deps.log.info({ node: node.id }, "rollout.waitingForLink");

			return { ok: false, waiting: true };
		}

		deps.log.info({ node: node.id, version: target.version }, "rollout.draining");

		const drained = await deps.drained(
			node.id,
			(options.graceMinutes ?? deps.drainMinutes) * 60_000 + DRAIN_SLACK_MS,
		);

		if (!drained) {
			return { ok: false, reason: "the node did not finish draining" };
		}

		const restartedAt = now();
		const restarted = await playbook(node, { image: target.pinned });

		if (!restarted.ok) {
			deps.log.error({ node: node.id, tail: tailOf(restarted) }, "rollout.restartFailed");

			return { ok: false, reason: "restarting the AppView failed" };
		}

		if (!(await waitForVersion(node.id, target.version ?? "", restartedAt))) {
			return { ok: false, reason: `the node did not come back on ${target.version}` };
		}

		deps.log.info({ node: node.id, version: target.version }, "rollout.nodeUpdated");

		return { ok: true };
	};

	const updateSelf = async (
		node: NodeRow,
		target: ResolvedImage,
		options: TickOptions,
	): Promise<StepResult> => {
		const successor = deps.yieldMain
			? takeoverCandidate(await deps.registry.list(), deps.self, target.version ?? "", now())
			: null;

		if (successor && deps.yieldMain) {
			const pulled = await playbook(node, {
				image: target.pinned,
				pull_only: true,
				stack_dir: deps.stackDir,
			});

			if (!pulled.ok) {
				deps.log.error({ node: node.id, tail: tailOf(pulled) }, "rollout.pullFailed");

				return { ok: false, reason: "pulling the image failed" };
			}

			deps.log.info({ node: node.id, successor: successor.id }, "rollout.handingOverMain");

			if (!(await deps.yieldMain(successor.id))) {
				return { ok: false, reason: `${successor.id} didn't take over the main role` };
			}

			handedOver = true;
		}

		const result = await playbook(node, {
			image: target.pinned,
			detach: true,
			stack_dir: deps.stackDir,
			...(options.graceMinutes === undefined
				? {}
				: { stop_timeout: Math.max(1, Math.ceil(options.graceMinutes * 60)) }),
		});

		if (!result.ok) {
			deps.log.error({ node: node.id, tail: tailOf(result) }, "rollout.restartFailed");

			return { ok: false, reason: "restarting the main node failed" };
		}

		restarting = true;
		deps.log.info({ node: node.id, version: target.version }, "rollout.restartingMain");

		return { ok: true };
	};

	const step = async (
		node: NodeRow,
		target: ResolvedImage,
		options: TickOptions,
	): Promise<StepResult> => {
		const deadline = now() + (deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);

		for (;;) {
			const result =
				node.id === deps.self
					? await updateSelf(node, target, options)
					: await updateNode(node, target, options);

			if (result.ok || !("waiting" in result) || options.graceMinutes === undefined) {
				return result;
			}

			if (now() >= deadline) {
				return { ok: false, reason: `${node.id} couldn't leave without breaking the quorum` };
			}

			await sleep(FORCED_RETRY_MS);
		}
	};

	const run = async (options: TickOptions): Promise<RolloutOutcome> => {
		if (await deps.registry.rolloutPaused()) {
			return "paused";
		}

		const target = await deps.resolve(deps.image).catch((error: unknown) => {
			deps.log.warn({ err: error, image: deps.image }, "rollout.resolveFailed");

			return null;
		});

		if (!target) {
			return "unreachable";
		}

		if (!target.version) {
			deps.log.warn({ image: deps.image, digest: target.digest }, "rollout.noVersionLabel");

			return "unversioned";
		}

		const since = now() - PEER_HEARTBEAT_WINDOW_MS;
		const behind = (await deps.registry.list()).filter(
			(node) => node.state === "active" && fresh(node, since) && node.version !== target.version,
		);

		if (behind.length === 0) {
			return "current";
		}

		deps.log.info(
			{
				version: target.version,
				nodes: behind.map((node) => node.id),
				...(options.graceMinutes === undefined ? {} : { graceMinutes: options.graceMinutes }),
			},
			"rollout.started",
		);

		for (const node of rolloutOrder(behind, deps.self)) {
			if (await deps.registry.rolloutPaused()) {
				return "paused";
			}

			if (!deps.active()) {
				return "busy";
			}

			const result = await step(node, target, options);

			if (result.ok) {
				continue;
			}

			if ("waiting" in result) {
				return "waiting";
			}

			await deps.registry.pauseRollout();
			deps.log.error(
				{ node: node.id, version: target.version, reason: result.reason },
				"rollout.paused",
			);

			return "failed";
		}

		if (handedOver) {
			return "handedOver";
		}

		return restarting ? "restarting" : "updated";
	};

	return {
		get running() {
			return running;
		},
		tick: async (options = {}) => {
			if (running || restarting || !deps.active()) {
				return "busy";
			}

			running = true;

			try {
				return await run(options);
			} finally {
				running = false;
			}
		},
	};
};
