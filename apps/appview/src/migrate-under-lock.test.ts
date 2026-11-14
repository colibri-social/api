import {
	knownMigrations,
	openDatabase,
	openTestDatabase,
	type TestDatabase,
} from "@colibri-social/appview-db";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUnderLock, waitForMigrations } from "./locks.js";

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

describe("waitForMigrations", () => {
	let database: TestDatabase;

	beforeEach(async () => {
		database = await openTestDatabase();
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("returns at once on a migrated database", async () => {
		const log = { info: vi.fn() };
		const sleep = vi.fn(async () => {});

		await waitForMigrations(database, log, { sleep });

		expect(sleep).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});

	it("waits until the main node applied every known migration", async () => {
		const known = knownMigrations(database.dialect);
		const counts = [known - 1, known - 1, known];
		const log = { info: vi.fn() };
		const sleep = vi.fn(async () => {});

		await waitForMigrations(database, log, {
			applied: async () => counts.shift() ?? known,
			sleep,
		});

		expect(sleep).toHaveBeenCalledTimes(2);
		expect(log.info).toHaveBeenCalledWith(
			{ applied: known - 1, known },
			"migrations.waitingForMain",
		);
	});

	it("starts an older node against a newer schema", async () => {
		const known = knownMigrations(database.dialect);
		const sleep = vi.fn(async () => {});

		await waitForMigrations(
			database,
			{ info: vi.fn() },
			{
				applied: async () => known + 1,
				sleep,
			},
		);

		expect(sleep).not.toHaveBeenCalled();
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
