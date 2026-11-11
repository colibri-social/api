import { createClient, type ResultSet } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle as drizzleLibsql, type LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { withReplicas } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import pg from "pg";
import { FollowingPool } from "./following.js";
import { isMultiHost } from "./hosts.js";
import { type AdvisoryLock, grantedLock, postgresAdvisoryLock } from "./lock.js";
import { schema as pgTables } from "./schema/pg.js";
import { type Schema, schema as sqliteTables } from "./schema/sqlite.js";

export type Dialect = "sqlite" | "postgres";

export type Db = LibSQLDatabase<Schema>;

export type Database = {
	db: Db;
	primary: Db;
	tables: Schema;
	dialect: Dialect;
	ping: () => Promise<void>;
	advisoryLock: (key: number) => AdvisoryLock;
	primaryUrl: () => Promise<string | null>;
	onPrimaryChange: (listener: (url: string) => void) => () => void;
	waitForReplay: (lsn: string, timeoutMs: number) => Promise<boolean>;
	close: () => Promise<void>;
};

export type DatabaseOptions = {
	url: string;
	authToken?: string;
	maxConnections?: number;
	readUrl?: string;
};

export const dialectFor = (url: string): Dialect =>
	/^postgres(ql)?:\/\//.test(url) ? "postgres" : "sqlite";

const asCanonical = <T>(value: unknown): T => value as T;

const openSqlite = ({ url, authToken }: DatabaseOptions): Database => {
	const client = createClient(authToken ? { url, authToken } : { url });
	const db = drizzleLibsql(client, { schema: sqliteTables });
	return {
		db,
		primary: db,
		tables: sqliteTables,
		dialect: "sqlite",
		ping: async () => {
			await db.run(sql`select 1`);
		},
		advisoryLock: () => grantedLock(),
		primaryUrl: async () => null,
		onPrimaryChange: () => () => {},
		waitForReplay: async () => true,
		close: async () => client.close(),
	};
};

const openPostgres = ({ url, maxConnections, readUrl }: DatabaseOptions): Database => {
	const max = maxConnections ?? 20;
	const following = isMultiHost(url) ? new FollowingPool({ url, max }) : null;
	const pool = following ?? new pg.Pool({ connectionString: url, max });
	const primary = drizzlePg(pool, { schema: pgTables });
	const readPool = readUrl ? new pg.Pool({ connectionString: readUrl, max }) : null;
	const db = readPool
		? withReplicas(primary, [drizzlePg(readPool, { schema: pgTables })])
		: primary;

	return {
		db: asCanonical<Db>(db),
		primary: asCanonical<Db>(primary),
		tables: asCanonical<Schema>(pgTables),
		dialect: "postgres",
		ping: async () => {
			await primary.execute(sql`select 1`);
		},
		advisoryLock: (key) =>
			postgresAdvisoryLock(following ? () => following.primaryUrl() : url, key),
		primaryUrl: async () => (following ? following.primaryUrl() : url),
		onPrimaryChange: (listener) => following?.onSwitch(listener) ?? (() => {}),
		waitForReplay: (lsn, timeoutMs) => {
			return readPool ? waitForReplay(readPool, lsn, timeoutMs) : Promise.resolve(true);
		},
		close: async () => {
			await pool.end();
			await readPool?.end();
		},
	};
};

const REPLAY_POLL_MS = 50;

const waitForReplay = async (pool: pg.Pool, lsn: string, timeoutMs: number): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const result = await pool.query<{ caught_up: boolean | null }>(
			"select pg_last_wal_replay_lsn() >= $1::pg_lsn as caught_up",
			[lsn],
		);
		const caughtUp = result.rows[0]?.caught_up;

		if (caughtUp !== false) {
			return true;
		}

		if (Date.now() >= deadline) {
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS));
	}
};

export const openDatabase = (options: DatabaseOptions): Database =>
	dialectFor(options.url) === "postgres" ? openPostgres(options) : openSqlite(options);

export type Queryable = BaseSQLiteDatabase<"async", ResultSet, Schema>;
