import pg from "pg";
import type { Logger } from "../logger.js";
import {
	blocking,
	type DatabaseStatus,
	formatChecks,
	readDatabaseStatus,
	type SwitchoverCheck,
	switchoverChecks,
} from "./db-status.js";
import {
	bumpEpoch,
	createSlots,
	fenceHost,
	PROMOTE_TIMEOUT_SECONDS,
	slotName,
	stopReplication,
	unfenceHost,
} from "./failover.js";
import { nodeDatabaseUrl } from "./fencing.js";
import type { NodeRow, Registry } from "./registry.js";

export const CATCH_UP_TIMEOUT_MS = 30_000;

export type FailbackDeps = {
	self: string;
	localUrl: string | null;
	databaseUrl: string;
	nodes: () => Promise<NodeRow[]>;
	yieldMain: (target: string) => Promise<boolean>;
	log: Pick<Logger, "info" | "warn" | "error">;
	version: string;
	rollouts?: Pick<Registry, "rolloutPaused" | "pauseRollout" | "resumeRollout"> & {
		running: () => boolean;
	};
	busy?: () => string | null;
	status?: (nodes: readonly NodeRow[]) => Promise<DatabaseStatus>;
	connect?: (url: string) => Promise<pg.Client>;
	now?: () => number;
	catchUpMs?: number;
	pollMs?: number;
};

export type FailbackResult = { ok: true; message: string } | { ok: false; message: string };

export type SwitchoverPlan = {
	target: string | null;
	checks: SwitchoverCheck[];
	nodes: NodeRow[];
};

const open = async (url: string): Promise<pg.Client> => {
	const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });

	client.on("error", () => {});
	await client.connect();

	return client;
};

const single = async <T>(
	connect: (url: string) => Promise<pg.Client>,
	url: string,
	sql: string,
	params: unknown[] = [],
): Promise<T | undefined> => {
	const client = await connect(url);

	try {
		return (await client.query(sql, params)).rows[0] as T | undefined;
	} finally {
		await client.end().catch(() => {});
	}
};

export const checkSwitchover = async (
	deps: FailbackDeps,
	targetId: string | undefined,
): Promise<SwitchoverPlan> => {
	const nodes = await deps.nodes();
	const status = await (deps.status
		? deps.status(nodes)
		: readDatabaseStatus({ databaseUrl: deps.databaseUrl, nodes }));
	const target =
		targetId ??
		nodes.find(
			(node) =>
				node.id !== status.primary &&
				node.state !== "retired" &&
				(node.roles.includes("main") || node.roles.includes("failover")),
		)?.id ??
		null;

	if (target === null) {
		return {
			target,
			nodes,
			checks: [
				{
					ok: false,
					required: true,
					label: "a node with the main or failover role is free to take the primary",
					detail: "Name the node to switch over to with `colibri-admin db switchover <node>`",
				},
			],
		};
	}

	return {
		target,
		nodes,
		checks: switchoverChecks({
			status,
			nodes,
			target,
			version: deps.version,
			now: (deps.now ?? Date.now)(),
			rolloutRunning: deps.rollouts?.running() ?? false,
			busy: deps.busy?.() ?? null,
		}),
	};
};

const resumeRollouts = async (deps: FailbackDeps, wasPaused: boolean): Promise<string> => {
	if (wasPaused || !deps.rollouts) {
		return "";
	}

	try {
		await deps.rollouts.resumeRollout();

		return "";
	} catch (error) {
		deps.log.warn({ err: error }, "failback.resumeRolloutFailed");

		return ". Rollouts are still paused, run `colibri-admin rollout resume`";
	}
};

const movePrimary = async (
	deps: FailbackDeps,
	localUrl: string,
	connect: (url: string) => Promise<pg.Client>,
	target: NodeRow,
	nodes: readonly NodeRow[],
): Promise<FailbackResult> => {
	const targetUrl = nodeDatabaseUrl(deps.databaseUrl, target);

	await fenceHost(localUrl, { keepLocks: true, keepReplication: true });
	await stopReplication(localUrl, slotName(target.id));
	deps.log.warn({ target: target.id }, "failback.fenced");

	const lsn = await single<{ lsn: string }>(
		connect,
		localUrl,
		"select pg_current_wal_lsn()::text as lsn",
	);
	const deadline = Date.now() + (deps.catchUpMs ?? CATCH_UP_TIMEOUT_MS);
	let caughtUp = false;

	while (Date.now() < deadline) {
		const replay = await single<{ caught_up: boolean }>(
			connect,
			targetUrl,
			"select pg_last_wal_replay_lsn() >= $1::pg_lsn as caught_up",
			[lsn?.lsn],
		).catch(() => undefined);

		if (replay?.caught_up) {
			caughtUp = true;
			break;
		}

		await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 200));
	}

	if (!caughtUp) {
		await unfenceHost(localUrl).catch(() => undefined);

		return {
			ok: false,
			message: `${target.id} didn't catch up within 30 seconds. Writes go to this node again`,
		};
	}

	await stopReplication(localUrl, null);

	const client = await connect(targetUrl);

	try {
		const promoted = await client.query<{ done: boolean }>("select pg_promote(true, $1) as done", [
			PROMOTE_TIMEOUT_SECONDS,
		]);

		if (!promoted.rows[0]?.done) {
			throw new Error("promotion timed out");
		}

		const epoch = await bumpEpoch(client, target.id, new Date().toISOString());

		await createSlots(
			client,
			nodes
				.filter((node) => node.id !== target.id && node.state !== "retired")
				.map((node) => slotName(node.id)),
		);

		deps.log.warn({ target: target.id, epoch }, "failback.promoted");
	} catch (error) {
		await unfenceHost(localUrl).catch(() => undefined);

		return {
			ok: false,
			message: `promoting ${target.id} failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		await client.end().catch(() => {});
	}

	const handedOver = await deps.yieldMain(target.id);

	return {
		ok: true,
		message: handedOver
			? `${target.id} is the primary now. This node's Postgres is rebuilt as its replica`
			: `${target.id} is the primary now, but it hasn't taken the main role yet`,
	};
};

export const runFailback = async (
	deps: FailbackDeps,
	targetId: string | undefined,
	options: { force?: boolean } = {},
): Promise<FailbackResult> => {
	const connect = deps.connect ?? open;

	if (!deps.localUrl) {
		return { ok: false, message: "this main node has no local Postgres to hand over" };
	}

	const local = await single<{ recovery: boolean }>(
		connect,
		deps.localUrl,
		"select pg_is_in_recovery() as recovery",
	).catch(() => undefined);

	if (!local || local.recovery) {
		return { ok: false, message: "this node's Postgres isn't the primary" };
	}

	const plan = await checkSwitchover(deps, targetId);
	const blockers = blocking(plan.checks, options.force ?? false);
	const target = plan.nodes.find((node) => node.id === plan.target);

	if (!target || blockers.length > 0) {
		return { ok: false, message: `the switchover can't start:\n${formatChecks(blockers)}` };
	}

	const wasPaused = (await deps.rollouts?.rolloutPaused().catch(() => true)) ?? true;

	if (!wasPaused) {
		await deps.rollouts?.pauseRollout();
	}

	let result: FailbackResult;
	let note: string;

	try {
		result = await movePrimary(deps, deps.localUrl, connect, target, plan.nodes);
	} finally {
		note = await resumeRollouts(deps, wasPaused);
	}

	return { ok: result.ok, message: `${result.message}${note}` };
};
