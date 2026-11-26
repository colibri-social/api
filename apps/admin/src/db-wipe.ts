import {
	MONITORING_FINGERPRINT_KEY,
	PEER_HEARTBEAT_WINDOW_MS,
	type Registry,
} from "@colibri-social/appview/cluster";
import type { Database } from "@colibri-social/appview-db";
import { ne, sql } from "drizzle-orm";
import { type AnyTable, countRows, tableName } from "./db-copy.js";

export const KEPT_TABLES: readonly string[] = [
	"cluster_config",
	"cluster_state",
	"nodes",
	"node_join_tokens",
	"service_state",
	"telemetry_state",
];

export const POLYFILL_PREFIX = "polyfill/";

export type WipeBucket = {
	countPrefix: (prefix: string) => Promise<number>;
	deletePrefix: (prefix: string) => Promise<number>;
};

export type TableRows = {
	table: string;
	rows: number;
};

export type WipePlan = {
	tables: TableRows[];
	objects: number | null;
};

export type WipeOptions = {
	database: Database;
	registry: Pick<Registry, "list" | "networkParked">;
	bucket: WipeBucket | null;
	force: boolean;
	now: () => Date;
	beforeWipe: (plan: WipePlan) => Promise<void>;
	print: (line: string) => void;
};

export class WipeRefusedError extends Error {}

const checkNetworkDown = async (options: WipeOptions): Promise<void> => {
	if (!(await options.registry.networkParked())) {
		throw new WipeRefusedError(
			"the network isn't down. Run colibri-admin network down first, or pass --force",
		);
	}

	const since = options.now().getTime() - PEER_HEARTBEAT_WINDOW_MS;
	const serving = (await options.registry.list()).filter(
		(node) =>
			node.state !== "maintenance" &&
			node.state !== "retired" &&
			node.heartbeatAt !== null &&
			new Date(node.heartbeatAt).getTime() > since,
	);

	if (serving.length > 0) {
		throw new WipeRefusedError(
			`${serving.map((node) => `${node.id} (${node.state})`).join(", ")} still serve. Wait until colibri-admin node list shows them in maintenance, or pass --force`,
		);
	}
};

const wipedTables = (database: Database): AnyTable[] => {
	return (Object.values(database.tables) as AnyTable[])
		.filter((table) => !KEPT_TABLES.includes(tableName(table)))
		.sort((a, b) => tableName(a).localeCompare(tableName(b)));
};

const execute = async (database: Database, query: unknown): Promise<void> => {
	await (database.primary as unknown as { execute: (query: unknown) => Promise<unknown> }).execute(
		query,
	);
};

export const wipeDatabase = async (options: WipeOptions): Promise<WipePlan> => {
	const { database, bucket, print } = options;

	if (database.dialect !== "postgres") {
		throw new WipeRefusedError("db wipe only runs against the Postgres database");
	}

	if (!options.force) {
		await checkNetworkDown(options);
	}

	const tables = wipedTables(database);
	const counted: TableRows[] = [];

	for (const table of tables) {
		counted.push({ table: tableName(table), rows: await countRows(database, table) });
	}

	const plan: WipePlan = {
		tables: counted.filter((entry) => entry.rows > 0),
		objects: bucket ? await bucket.countPrefix(POLYFILL_PREFIX) : null,
	};

	await options.beforeWipe(plan);

	await execute(
		database,
		sql.raw(`truncate table ${tables.map((table) => `"${tableName(table)}"`).join(", ")}`),
	);
	await database.primary
		.delete(database.tables.serviceState)
		.where(ne(database.tables.serviceState.key, MONITORING_FINGERPRINT_KEY));
	print(`Emptied ${tables.length} tables and reset the service state.`);

	if (bucket) {
		const deleted = await bucket.deletePrefix(POLYFILL_PREFIX);

		print(`Deleted ${deleted} objects under ${POLYFILL_PREFIX} in the polyfill bucket.`);
	} else {
		print("No polyfill bucket is configured, so no objects were deleted.");
	}

	return plan;
};
