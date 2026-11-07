import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { type Database, openDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

export type TestDatabase = Database & { url: string; destroy: () => Promise<void> };

const withAdmin = async (url: string, statement: string): Promise<void> => {
	const admin = new pg.Client({ connectionString: url });

	await admin.connect();

	try {
		await admin.query(statement);
	} finally {
		await admin.end();
	}
};

const openPostgresTestDatabase = async (adminUrl: string): Promise<TestDatabase> => {
	const name = `colibri_test_${randomBytes(6).toString("hex")}`;
	const url = new URL(adminUrl);

	await withAdmin(adminUrl, `create database ${name}`);

	url.pathname = `/${name}`;

	const database = openDatabase({ url: url.toString(), maxConnections: 4 });

	await runMigrations(database);

	return {
		...database,
		url: url.toString(),
		destroy: async () => {
			await database.close();
			await withAdmin(adminUrl, `drop database if exists ${name} with (force)`);
		},
	};
};

const openSqliteTestDatabase = async (): Promise<TestDatabase> => {
	const directory = mkdtempSync(join(tmpdir(), "colibri-test-"));
	const url = `file:${join(directory, "test.db")}`;
	const database = openDatabase({ url });

	await runMigrations(database);

	return {
		...database,
		url,
		destroy: async () => {
			await database.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
};

export const openTestDatabase = async (): Promise<TestDatabase> => {
	const adminUrl = process.env.TEST_DATABASE_URL;

	if (adminUrl) {
		return openPostgresTestDatabase(adminUrl);
	}

	return openSqliteTestDatabase();
};
