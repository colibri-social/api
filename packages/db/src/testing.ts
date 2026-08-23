import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, openDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

export type TestDatabase = Database & { destroy: () => Promise<void> };

export const openTestDatabase = async (): Promise<TestDatabase> => {
	const directory = mkdtempSync(join(tmpdir(), "colibri-test-"));
	const database = openDatabase({ url: `file:${join(directory, "test.db")}` });
	await runMigrations(database);

	return {
		...database,
		destroy: async () => {
			await database.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
};
