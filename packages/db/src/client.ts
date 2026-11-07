import { createClient, type ResultSet } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle as drizzleLibsql, type LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { withReplicas } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import pg from "pg";
import { type AdvisoryLock, grantedLock, postgresAdvisoryLock } from "./lock.js";
import { schema as pgTables } from "./schema/pg.js";
import { type Schema, schema as sqliteTables } from "./schema/sqlite.js";

export type Dialect = "sqlite" | "postgres";

export type Db = LibSQLDatabase<Schema>;

export type Database = {
	db: Db;
	tables: Schema;
	dialect: Dialect;
	ping: () => Promise<void>;
	advisoryLock: (key: number) => AdvisoryLock;
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
		tables: sqliteTables,
		dialect: "sqlite",
		ping: async () => {
			await db.run(sql`select 1`);
		},
		advisoryLock: () => grantedLock(),
		close: async () => client.close(),
	};
};

const openPostgres = ({ url, maxConnections, readUrl }: DatabaseOptions): Database => {
	const max = maxConnections ?? 20;
	const pool = new pg.Pool({ connectionString: url, max });
	const primary = drizzlePg(pool, { schema: pgTables });
	const readPool = readUrl ? new pg.Pool({ connectionString: readUrl, max }) : null;
	const db = readPool
		? withReplicas(primary, [drizzlePg(readPool, { schema: pgTables })])
		: primary;

	return {
		db: asCanonical<Db>(db),
		tables: asCanonical<Schema>(pgTables),
		dialect: "postgres",
		ping: async () => {
			await primary.execute(sql`select 1`);
		},
		advisoryLock: (key) => postgresAdvisoryLock(url, key),
		close: async () => {
			await pool.end();
			await readPool?.end();
		},
	};
};

export const openDatabase = (options: DatabaseOptions): Database =>
	dialectFor(options.url) === "postgres" ? openPostgres(options) : openSqlite(options);

export type Queryable = BaseSQLiteDatabase<"async", ResultSet, Schema>;
