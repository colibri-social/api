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

export const appliedMigrations = async ({ primary, dialect }: Database): Promise<number> => {
	if (dialect === "postgres") {
		const result = await (
			primary as unknown as { execute: (query: SQL) => Promise<{ rows: { count: string }[] }> }
		)
			.execute(sql`select count(*) as count from drizzle.__drizzle_migrations`)
			.catch(() => ({ rows: [{ count: "0" }] }));

		return Number(result.rows[0]?.count ?? 0);
	}

	const row = await (primary as unknown as { get: (query: SQL) => Promise<{ count: number }> })
		.get(sql`select count(*) as count from __drizzle_migrations`)
		.catch(() => ({ count: 0 }));

	return Number(row?.count ?? 0);
};
