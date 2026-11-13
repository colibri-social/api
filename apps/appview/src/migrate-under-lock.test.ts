import { openDatabase, openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateUnderLock } from "./locks.js";

const adminUrl = process.env.TEST_DATABASE_URL;

const setReadOnly = async (url: string, value: "on" | "off"): Promise<void> => {
	const client = new pg.Client({ connectionString: adminUrl });
	const name = new URL(url).pathname.slice(1);

	await client.connect();

	try {
		await client.query(`alter database ${name} set default_transaction_read_only = ${value}`);
	} finally {
		await client.end();
	}
};

describe("migrateUnderLock", () => {
	it("migrates", async () => {
		const database = await openTestDatabase();

		try {
			expect(await migrateUnderLock(database)).toBe(true);
		} finally {
			await database.destroy();
		}
	});
});

describe.skipIf(!adminUrl)("migrateUnderLock on Postgres", () => {
	let database: TestDatabase;

	beforeEach(async () => {
		database = await openTestDatabase();
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("migrates a writable database", async () => {
		expect(await migrateUnderLock(database)).toBe(true);
	});

	it("skips a read-only database without throwing", async () => {
		await setReadOnly(database.url, "on");

		const reopened = openDatabase({ url: database.url, maxConnections: 2 });

		try {
			expect(await migrateUnderLock(reopened)).toBe(false);
		} finally {
			await reopened.close();
			await setReadOnly(database.url, "off");
		}
	});
});
