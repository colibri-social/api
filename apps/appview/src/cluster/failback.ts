import pg from "pg";
import type { Logger } from "../logger.js";
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
import type { NodeRow } from "./registry.js";

export const CATCH_UP_TIMEOUT_MS = 30_000;

export type FailbackDeps = {
	self: string;
	localUrl: string | null;
	databaseUrl: string;
	nodes: () => Promise<NodeRow[]>;
	yieldMain: (target: string) => Promise<boolean>;
	log: Pick<Logger, "info" | "warn" | "error">;
	connect?: (url: string) => Promise<pg.Client>;
	catchUpMs?: number;
	pollMs?: number;
};

export type FailbackResult = { ok: true; message: string } | { ok: false; message: string };

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

export const runFailback = async (
	deps: FailbackDeps,
	targetId: string | undefined,
): Promise<FailbackResult> => {
	const connect = deps.connect ?? open;

	if (!deps.localUrl) {
		return { ok: false, message: "this main node has no local Postgres to hand over" };
	}

	const nodes = await deps.nodes();
	const target = targetId
		? nodes.find((node) => node.id === targetId)
		: nodes.find((node) => node.id !== deps.self && node.roles.includes("main"));

	if (!target || target.id === deps.self) {
		return {
			ok: false,
			message: targetId
				? `no other node is called ${targetId}`
				: "no node with the main role to fail back to",
		};
	}

	const targetUrl = nodeDatabaseUrl(deps.databaseUrl, target);
	const local = await single<{ recovery: boolean; epoch: number | null }>(
		connect,
		deps.localUrl,
		"select pg_is_in_recovery() as recovery, (select epoch from cluster_state where id = 'cluster') as epoch",
	);

	if (!local || local.recovery) {
		return { ok: false, message: "this node's Postgres isn't the primary" };
	}

	const receiver = await single<{ recovery: boolean; status: string | null }>(
		connect,
		targetUrl,
		"select pg_is_in_recovery() as recovery, (select status from pg_stat_wal_receiver limit 1) as status",
	).catch(() => undefined);

	if (!receiver?.recovery || receiver.status !== "streaming") {
		return {
			ok: false,
			message: `${target.id}'s Postgres isn't a streaming replica yet (${receiver ? (receiver.status ?? "not streaming") : "unreachable"})`,
		};
	}

	await fenceHost(deps.localUrl, { keepLocks: true, keepReplication: true });
	await stopReplication(deps.localUrl, slotName(target.id));
	deps.log.warn({ target: target.id }, "failback.fenced");

	const lsn = await single<{ lsn: string }>(
		connect,
		deps.localUrl,
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
		await unfenceHost(deps.localUrl).catch(() => undefined);

		return {
			ok: false,
			message: `${target.id} didn't catch up within 30 seconds. Writes go to this node again`,
		};
	}

	await stopReplication(deps.localUrl, null);

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
		await unfenceHost(deps.localUrl).catch(() => undefined);

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
			? `${target.id} is the primary again. This node's Postgres is rebuilt as its replica`
			: `${target.id} is the primary again, but it hasn't taken the main role yet`,
	};
};
