import { fileURLToPath } from "node:url";
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
