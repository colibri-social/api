import { createClient, type ResultSet } from "@libsql/client";
import { drizzle as drizzleLibsql, type LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import pg from "pg";
import { schema as pgTables } from "./schema/pg.js";
import { type Schema, schema as sqliteTables } from "./schema/sqlite.js";

export type Dialect = "sqlite" | "postgres";

export type Db = LibSQLDatabase<Schema>;

export type Database = {
	db: Db;
	tables: Schema;
	dialect: Dialect;
	close: () => Promise<void>;
};

export type DatabaseOptions = {
	url: string;
	authToken?: string;
	maxConnections?: number;
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
		close: async () => client.close(),
	};
};

const openPostgres = ({ url, maxConnections }: DatabaseOptions): Database => {
	const pool = new pg.Pool({ connectionString: url, max: maxConnections ?? 20 });
	const db = drizzlePg(pool, { schema: pgTables });
	return {
		db: asCanonical<Db>(db),
		tables: asCanonical<Schema>(pgTables),
		dialect: "postgres",
		close: () => pool.end(),
	};
};

export const openDatabase = (options: DatabaseOptions): Database =>
	dialectFor(options.url) === "postgres" ? openPostgres(options) : openSqlite(options);

export type Queryable = BaseSQLiteDatabase<"async", ResultSet, Schema>;
