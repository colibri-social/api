import { type HostProbe, hostUrls, pickPrimary, probeHost } from "@colibri-social/appview-db";
import pg from "pg";
import type { Logger } from "../logger.js";
import { ALIVE_PATH, type Alive, aliveSchema } from "./protocol.js";
import { CLUSTER_STATE_ID, type NodeRow } from "./registry.js";

export const PRIMARY_CHECK_MS = 5_000;

export const FAILOVER_CHECK_MS = 5_000;

export const PROMOTE_TIMEOUT_SECONDS = 60;

export type PrimaryWatch = {
	readonly downSince: number | null;
	stop: () => void;
};

export type Witness = {
	node: string;
	answer: Alive | null;
};

export type PromoteDecision = { promote: true } | { promote: false; reason: string };

export type PromoteOptions = {
	localUrl: string;
	nodeId: string;
	slots: readonly string[];
	log: Pick<Logger, "info" | "warn">;
};

export type FailoverWatchDeps = {
	nodeId: string;
	localUrl: string;
	databaseUrl: string;
	afterMs: number;
	primary: () => number | null;
	nodes: () => Promise<NodeRow[]>;
	ask: (node: NodeRow) => Promise<Alive | null>;
	probe?: (url: string) => Promise<HostProbe>;
	promote?: (options: PromoteOptions) => Promise<void>;
	onPromoted: () => void;
	log: Pick<Logger, "info" | "warn" | "error">;
	now?: () => number;
};

export const slotName = (nodeId: string): string => {
	return nodeId.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
};

export const witnessesOf = (nodes: readonly NodeRow[], self: string): NodeRow[] => {
	return nodes.filter(
		(node) =>
			node.id !== self &&
			node.state !== "maintenance" &&
			node.state !== "retired" &&
			!node.roles.includes("main") &&
			!node.roles.includes("failover"),
	);
};

export const decidePromotion = (input: {
	selfDownSince: number | null;
	witnesses: readonly Witness[];
	now: number;
	afterMs: number;
}): PromoteDecision => {
	const { selfDownSince, witnesses, now, afterMs } = input;

	if (selfDownSince === null || now - selfDownSince < afterMs) {
		return { promote: false, reason: "the primary answers this node" };
	}

	if (witnesses.length === 0) {
		return { promote: false, reason: "no other node can confirm that the primary is gone" };
	}

	const agreeing = witnesses.filter(
		(witness) =>
			witness.answer?.primaryDownSince !== undefined &&
			witness.answer.primaryDownSince !== null &&
			now - witness.answer.primaryDownSince >= afterMs,
	).length;

	if (agreeing * 2 <= witnesses.length) {
		return {
			promote: false,
			reason: `${agreeing} of ${witnesses.length} other nodes lost the primary`,
		};
	}

	return { promote: true };
};

export const watchPrimary = (options: {
	ping: () => Promise<void>;
	log: Pick<Logger, "info" | "warn">;
	now?: () => number;
	intervalMs?: number;
}): PrimaryWatch => {
	const now = options.now ?? Date.now;
	let downSince: number | null = null;
	let checking = false;

	const check = async () => {
		if (checking) {
			return;
		}

		checking = true;

		try {
			await Promise.race([
				options.ping(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 4_000)),
			]);

			if (downSince !== null) {
				options.log.info({ downMs: now() - downSince }, "primary.back");
			}

			downSince = null;
		} catch (error) {
			if (downSince === null) {
				downSince = now();
				options.log.warn({ err: error }, "primary.unreachable");
			}
		} finally {
			checking = false;
		}
	};

	const timer = setInterval(() => void check(), options.intervalMs ?? PRIMARY_CHECK_MS);

	timer.unref?.();

	return {
		get downSince() {
			return downSince;
		},
		stop: () => clearInterval(timer),
	};
};

export const askAlive = async (node: NodeRow, timeoutMs = 2_000): Promise<Alive | null> => {
	try {
		const response = await fetch(new URL(ALIVE_PATH, node.tailnetUrl), {
			signal: AbortSignal.timeout(timeoutMs),
		});
		const parsed = response.ok ? aliveSchema.safeParse(await response.json()) : null;

		return parsed?.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const withClient = async <T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> => {
	const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });

	client.on("error", () => {});
	await client.connect();

	try {
		return await run(client);
	} finally {
		await client.end().catch(() => {});
	}
};

export const bumpEpoch = async (client: pg.Client, nodeId: string, at: string): Promise<number> => {
	const result = await client.query<{ epoch: number }>(
		`insert into cluster_state (id, epoch, main_node_id, write_mode, rollout_paused, updated_at)
		values ($1, 2, $2, 'normal', false, $3)
		on conflict (id) do update set epoch = cluster_state.epoch + 1, main_node_id = $2, updated_at = $3
		returning epoch`,
		[CLUSTER_STATE_ID, nodeId, at],
	);

	return Number(result.rows[0]?.epoch ?? 0);
};

export const createSlots = async (client: pg.Client, slots: readonly string[]): Promise<void> => {
	for (const slot of slots) {
		await client.query(
			"select pg_create_physical_replication_slot($1) where not exists (select 1 from pg_replication_slots where slot_name = $1)",
			[slot],
		);
	}
};

export const promoteLocal = async (options: PromoteOptions): Promise<number> => {
	return withClient(options.localUrl, async (client) => {
		const status = await client.query<{ recovery: boolean }>(
			"select pg_is_in_recovery() as recovery",
		);

		if (!status.rows[0]?.recovery) {
			throw new Error("the local Postgres is already a primary");
		}

		const promoted = await client.query<{ done: boolean }>("select pg_promote(true, $1) as done", [
			PROMOTE_TIMEOUT_SECONDS,
		]);

		if (!promoted.rows[0]?.done) {
			throw new Error("Postgres didn't finish promoting in time");
		}

		const epoch = await bumpEpoch(client, options.nodeId, new Date().toISOString());

		await createSlots(client, options.slots);
		options.log.info({ epoch, slots: options.slots.length }, "failover.promoted");

		return epoch;
	});
};

export const fenceHost = async (
	url: string,
	options: { keepLocks?: boolean; keepReplication?: boolean } = {},
): Promise<void> => {
	await withClient(url, async (client) => {
		const kinds = options.keepReplication
			? "('client backend')"
			: "('client backend', 'walsender')";

		await client.query("alter system set default_transaction_read_only = on");
		await client.query("select pg_reload_conf()");
		await client.query(
			`select pg_terminate_backend(pid) from pg_stat_activity
			where pid <> pg_backend_pid() and backend_type in ${kinds}${
				options.keepLocks
					? " and pid not in (select pid from pg_locks where locktype = 'advisory' and granted)"
					: ""
			}`,
		);
	});
};

export const stopReplication = async (url: string, keepSlot: string | null): Promise<void> => {
	await withClient(url, async (client) => {
		await client.query(
			`select pg_terminate_backend(pid) from pg_stat_activity
			where backend_type = 'walsender'${
				keepSlot
					? " and pid is distinct from (select active_pid from pg_replication_slots where slot_name = $1)"
					: ""
			}`,
			keepSlot ? [keepSlot] : [],
		);
	});
};

export const unfenceHost = async (url: string): Promise<void> => {
	await withClient(url, async (client) => {
		await client.query("alter system reset default_transaction_read_only");
		await client.query("select pg_reload_conf()");
	});
};

export const createFailoverWatch = (deps: FailoverWatchDeps) => {
	const now = deps.now ?? Date.now;
	const probe = deps.probe ?? probeHost;
	const promote =
		deps.promote ?? (async (options: PromoteOptions) => void (await promoteLocal(options)));
	let cached: NodeRow[] = [];
	let promoted = false;
	let running = false;
	let lastReason: string | null = null;

	const refresh = async () => {
		cached = await deps.nodes().catch(() => cached);
	};

	return {
		refresh,
		tick: async (): Promise<"skipped" | "waiting" | "promoted" | "failed"> => {
			if (promoted || running) {
				return "skipped";
			}

			running = true;

			try {
				if (deps.primary() === null) {
					lastReason = null;
					await refresh();

					return "skipped";
				}

				const witnesses = await Promise.all(
					witnessesOf(cached, deps.nodeId).map(async (node) => ({
						node: node.id,
						answer: await deps.ask(node),
					})),
				);
				const decision = decidePromotion({
					selfDownSince: deps.primary(),
					witnesses,
					now: now(),
					afterMs: deps.afterMs,
				});

				if (!decision.promote) {
					if (decision.reason !== lastReason) {
						deps.log.info({ reason: decision.reason }, "failover.waiting");
						lastReason = decision.reason;
					}

					return "waiting";
				}

				const probes = await Promise.all(hostUrls(deps.databaseUrl).map((url) => probe(url)));

				if (pickPrimary(probes)) {
					deps.log.info("failover.primaryAnswersAgain");

					return "waiting";
				}

				const local = await probe(deps.localUrl);

				if (!local.reachable || !local.recovery) {
					deps.log.warn({ reachable: local.reachable }, "failover.localNotStandby");

					return "failed";
				}

				deps.log.warn({ witnesses: witnesses.length }, "failover.promoting");

				await promote({
					localUrl: deps.localUrl,
					nodeId: deps.nodeId,
					slots: cached
						.filter((node) => node.id !== deps.nodeId && node.state !== "retired")
						.map((node) => slotName(node.id)),
					log: deps.log,
				});
				promoted = true;
				deps.onPromoted();

				return "promoted";
			} catch (error) {
				deps.log.error({ err: error }, "failover.failed");

				return "failed";
			} finally {
				running = false;
			}
		},
	};
};
