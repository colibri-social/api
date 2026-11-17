import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

const folderFor = (dialect: Database["dialect"]) =>
	fileURLToPath(
		new URL(`../migrations/${dialect === "postgres" ? "pg" : "sqlite"}`, import.meta.url),
	);

export const runMigrations = async ({ db, dialect }: Database): Promise<void> => {
	const migrationsFolder = folderFor(dialect);
	if (dialect === "postgres") {
		await migratePg(db as never, { migrationsFolder });
		return;
	}
	await migrateLibsql(db, { migrationsFolder });
};

export const knownMigrations = (dialect: Database["dialect"]): number => {
	const journal = JSON.parse(
		readFileSync(join(folderFor(dialect), "meta", "_journal.json"), "utf8"),
	) as { entries: unknown[] };

	return journal.entries.length;
};

export const acceptsWrites = async ({ primary, dialect }: Database): Promise<boolean> => {
	if (dialect !== "postgres") {
		return true;
	}

	const result = await (
		primary as unknown as {
			execute: (query: SQL) => Promise<{ rows: { recovery: boolean; read_only: string }[] }>;
		}
	)
		.execute(
			sql`select pg_is_in_recovery() as recovery, current_setting('default_transaction_read_only') as read_only`,
		)
		.catch(() => null);
	const row = result?.rows[0];

	return row !== undefined && !row.recovery && row.read_only !== "on";
};

export const appliedMigrations = async ({ primary, dialect }: Database): Promise<number> => {
	if (dialect === "postgres") {
		const executor = primary as unknown as {
			execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
		};
		const table = await executor.execute(
			sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
		);

		if (table.rows[0]?.present !== true) {
			return 0;
		}

		const result = await executor.execute(
			sql`select count(*) as count from drizzle.__drizzle_migrations`,
		);

		return Number(result.rows[0]?.count ?? 0);
	}

	const reader = primary as unknown as {
		get: (query: SQL) => Promise<{ count: number } | undefined>;
	};
	const table = await reader.get(
		sql`select count(*) as count from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
	);

	if (Number(table?.count ?? 0) === 0) {
		return 0;
	}

	const row = await reader.get(sql`select count(*) as count from __drizzle_migrations`);

	return Number(row?.count ?? 0);
};
