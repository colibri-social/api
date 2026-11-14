import pg from "pg";
import { slotName } from "./failover.js";
import { nodeDatabaseUrl } from "./fencing.js";
import { ready } from "./handover.js";
import type { NodeRow } from "./registry.js";

export const SWITCHOVER_MAX_LAG_BYTES = 16 * 1024 * 1024;

export const NODE_PROBE_TIMEOUT_MS = 3_000;

export type PostgresRole = "primary" | "replica" | "fenced" | "unreachable";

export type NodeProbe = {
	recovery: boolean;
	readOnly: boolean;
	epoch: number;
	receiver: string | null;
	replayedAt: string | null;
	slotLag: Record<string, number>;
};

export type ProbeNode = (url: string) => Promise<NodeProbe | null>;

export type NodeDatabase = {
	id: string;
	postgres: PostgresRole;
	epoch: number | null;
	streaming: boolean;
	lagBytes: number | null;
	replayedAt: string | null;
};

export type DatabaseStatus = {
	nodes: NodeDatabase[];
	primary: string | null;
};

export type SwitchoverCheck = {
	ok: boolean;
	required: boolean;
	label: string;
	detail?: string;
};

export type SwitchoverInput = {
	status: DatabaseStatus;
	nodes: readonly NodeRow[];
	target: string;
	version: string;
	now: number;
	rolloutRunning: boolean;
	busy: string | null;
};

export const probeNode: ProbeNode = async (url) => {
	const client = new pg.Client({
		connectionString: url,
		connectionTimeoutMillis: NODE_PROBE_TIMEOUT_MS,
		query_timeout: NODE_PROBE_TIMEOUT_MS,
	});

	client.on("error", () => {});

	try {
		await client.connect();

		const status = await client.query<{
			recovery: boolean;
			read_only: string;
			receiver: string | null;
			replayed_at: string | null;
		}>(
			`select pg_is_in_recovery() as recovery,
				current_setting('default_transaction_read_only') as read_only,
				(select status from pg_stat_wal_receiver limit 1) as receiver,
				pg_last_xact_replay_timestamp()::text as replayed_at`,
		);
		const epoch = await client
			.query<{ epoch: number }>("select epoch from cluster_state where id = 'cluster'")
			.then((result) => Number(result.rows[0]?.epoch ?? 0))
			.catch(() => 0);
		const row = status.rows[0];
		const slotLag: Record<string, number> = {};

		if (row && !row.recovery) {
			const slots = await client
				.query<{ slot_name: string; lag: string | null }>(
					`select slot.slot_name, pg_wal_lsn_diff(pg_current_wal_lsn(), replication.replay_lsn)::text as lag
					from pg_stat_replication replication
					join pg_replication_slots slot on slot.active_pid = replication.pid`,
				)
				.then((result) => result.rows)
				.catch(() => []);

			for (const slot of slots) {
				if (slot.lag !== null) slotLag[slot.slot_name] = Number(slot.lag);
			}
		}

		return {
			recovery: row?.recovery ?? true,
			readOnly: row?.read_only === "on",
			epoch,
			receiver: row?.receiver ?? null,
			replayedAt: row?.replayed_at ?? null,
			slotLag,
		};
	} catch {
		return null;
	} finally {
		await client.end().catch(() => {});
	}
};

export const capableNodes = (nodes: readonly NodeRow[]): NodeRow[] => {
	return nodes.filter(
		(node) =>
			node.state !== "retired" && (node.roles.includes("main") || node.roles.includes("failover")),
	);
};

export const readDatabaseStatus = async (deps: {
	databaseUrl: string;
	nodes: readonly NodeRow[];
	probe?: ProbeNode;
}): Promise<DatabaseStatus> => {
	const probe = deps.probe ?? probeNode;
	const capable = capableNodes(deps.nodes);
	const probes = await Promise.all(
		capable.map(async (node) => ({
			node,
			probe: await probe(nodeDatabaseUrl(deps.databaseUrl, node)).catch(() => null),
		})),
	);
	const writable = probes.filter(
		(entry) => entry.probe && !entry.probe.recovery && !entry.probe.readOnly,
	);
	const primary = writable.reduce<(typeof probes)[number] | null>(
		(best, entry) =>
			best === null || (entry.probe?.epoch ?? 0) > (best.probe?.epoch ?? 0) ? entry : best,
		null,
	);

	const roleOf = (entry: (typeof probes)[number]): PostgresRole => {
		if (!entry.probe) {
			return "unreachable";
		}

		if (entry.probe.recovery) {
			return "replica";
		}

		return entry === primary ? "primary" : "fenced";
	};

	return {
		primary: primary?.node.id ?? null,
		nodes: probes.map((entry) => {
			const postgres = roleOf(entry);
			const lag = primary?.probe?.slotLag[slotName(entry.node.id)];

			return {
				id: entry.node.id,
				postgres,
				epoch: entry.probe ? entry.probe.epoch : null,
				streaming: entry.probe?.receiver === "streaming",
				lagBytes: postgres === "replica" && lag !== undefined ? lag : null,
				replayedAt: entry.probe?.replayedAt ?? null,
			};
		}),
	};
};

export const formatBytes = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}

	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const tailnetHost = (node: NodeRow): string => {
	return new URL(node.tailnetUrl).hostname;
};

export const missingDatabaseHost = (
	nodes: readonly NodeRow[],
	target: NodeRow,
): { node: string; hosts: string[] | null }[] => {
	const host = tailnetHost(target);

	return nodes
		.filter((node) => node.id !== target.id && node.state === "active")
		.filter((node) => !node.databaseHosts?.includes(host))
		.map((node) => ({ node: node.id, hosts: node.databaseHosts ?? null }));
};

export const switchoverChecks = (input: SwitchoverInput): SwitchoverCheck[] => {
	const target = input.nodes.find((node) => node.id === input.target);

	if (!target || target.state === "retired") {
		return [
			{
				ok: false,
				required: true,
				label: `${input.target} is a registered node`,
				detail: "Run `colibri-admin node list` to see the node IDs",
			},
		];
	}

	const canHoldMain = target.roles.includes("main") || target.roles.includes("failover");
	const database = input.status.nodes.find((node) => node.id === target.id);
	const missing = missingDatabaseHost(input.nodes, target);
	const lag = database?.lagBytes ?? null;
	const targetReady = ready(target, input.version, input.now);
	const streaming = database?.postgres === "replica" && database.streaming;
	const lagOk = lag !== null && lag <= SWITCHOVER_MAX_LAG_BYTES;

	return [
		{
			ok: canHoldMain,
			required: true,
			label: `${target.id} can hold the main role`,
			...(canHoldMain
				? {}
				: { detail: `It has the roles ${target.roles.join(", ")}. It needs main or failover` }),
		},
		{
			ok: input.status.primary !== null,
			required: true,
			label: "a Postgres primary accepts writes",
			...(input.status.primary === null
				? {
						detail:
							"Without a primary there's nothing to hand over. Use `colibri-admin db promote` on the failover node",
					}
				: {}),
		},
		{
			ok: input.status.primary !== target.id,
			required: true,
			label: `${target.id} isn't the primary already`,
		},
		{
			ok: targetReady,
			required: false,
			label: `${target.id} is active, heartbeating and on version ${input.version}`,
			...(targetReady
				? {}
				: {
						detail: `It's ${target.state} on version ${target.version || "unknown"}. Wait for it or update it first`,
					}),
		},
		{
			ok: streaming,
			required: true,
			label: `${target.id}'s Postgres streams from the primary`,
			...(streaming
				? {}
				: { detail: `It's ${database?.postgres ?? "unreachable"} and not streaming` }),
		},
		{
			ok: lagOk,
			required: false,
			label: `${target.id} is less than ${formatBytes(SWITCHOVER_MAX_LAG_BYTES)} behind`,
			...(lagOk
				? {}
				: {
						detail:
							lag === null
								? "The primary doesn't report its lag"
								: `It's ${formatBytes(lag)} behind. Wait for a quieter moment`,
					}),
		},
		{
			ok: !input.rolloutRunning,
			required: true,
			label: "no rollout is running",
			...(input.rolloutRunning ? { detail: "Wait for the rollout to finish" } : {}),
		},
		{
			ok: input.busy === null,
			required: true,
			label: "no backup or other switchover is running",
			...(input.busy === null ? {} : { detail: `A ${input.busy} is running. Wait for it` }),
		},
		{
			ok: missing.length === 0,
			required: false,
			label: `every active node can reach ${target.id}'s Postgres`,
			...(missing.length === 0
				? {}
				: {
						detail: `${missing
							.map(({ node, hosts }) =>
								hosts === null
									? `${node} doesn't report its DATABASE_URL`
									: `${node}'s DATABASE_URL lists ${hosts.join(", ")}`,
							)
							.join(
								". ",
							)}. Restart those nodes with \`colibri-admin node recover <id>\` so they read the current list`,
					}),
		},
	];
};

export const blocking = (checks: readonly SwitchoverCheck[], force: boolean): SwitchoverCheck[] => {
	return checks.filter((check) => !check.ok && (check.required || !force));
};

export const formatChecks = (checks: readonly SwitchoverCheck[]): string => {
	return checks
		.map((check) => {
			const mark = check.ok ? "ok  " : check.required ? "FAIL" : "WARN";

			return check.detail
				? `${mark} ${check.label}\n     ${check.detail}`
				: `${mark} ${check.label}`;
		})
		.join("\n");
};
