import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.TEST_DATABASE_URL;

const admin = async (statement: string): Promise<void> => {
	const client = new pg.Client({ connectionString: adminUrl });

	await client.connect();

	try {
		await client.query(statement);
	} finally {
		await client.end();
	}
};

const urlFor = (name: string): string => {
	const url = new URL(adminUrl as string);

	url.pathname = `/${name}`;

	return url.toString();
};

const createMigrated = async (name: string): Promise<void> => {
	await admin(`create database ${name}`);

	const database = openDatabase({ url: urlFor(name), maxConnections: 2 });

	await runMigrations(database);
	await database.close();
};

describe.skipIf(!adminUrl)("a database with a read replica", () => {
	const suffix = randomBytes(6).toString("hex");
	const primaryName = `colibri_test_primary_${suffix}`;
	const replicaName = `colibri_test_replica_${suffix}`;
	let replica: Database;
	let database: Database;

	const now = new Date("2026-11-07T12:00:00Z").toISOString();

	beforeAll(async () => {
		await createMigrated(primaryName);
		await createMigrated(replicaName);

		replica = openDatabase({ url: urlFor(replicaName), maxConnections: 2 });
		database = openDatabase({
			url: urlFor(primaryName),
			readUrl: urlFor(replicaName),
			maxConnections: 2,
		});

		await replica.db
			.insert(replica.tables.serviceState)
			.values({ key: "where", value: "replica", updatedAt: now });
	});

	afterAll(async () => {
		await database?.close();
		await replica?.close();
		await admin(`drop database if exists ${primaryName} with (force)`);
		await admin(`drop database if exists ${replicaName} with (force)`);
	});

	it("reads from the replica", async () => {
		const { db, tables } = database;
		const rows = await db
			.select({ value: tables.serviceState.value })
			.from(tables.serviceState)
			.where(eq(tables.serviceState.key, "where"));

		expect(rows).toEqual([{ value: "replica" }]);
	});

	it("writes to the primary", async () => {
		const { db, tables } = database;

		await db
			.insert(tables.serviceState)
			.values({ key: "written", value: "primary", updatedAt: now });

		const onReplica = await replica.db
			.select()
			.from(replica.tables.serviceState)
			.where(eq(replica.tables.serviceState.key, "written"));

		expect(onReplica).toEqual([]);

		const primary = openDatabase({ url: urlFor(primaryName), maxConnections: 1 });
		const onPrimary = await primary.db
			.select({ value: primary.tables.serviceState.value })
			.from(primary.tables.serviceState)
			.where(eq(primary.tables.serviceState.key, "written"));

		await primary.close();

		expect(onPrimary).toEqual([{ value: "primary" }]);
	});

	it("reads inside a transaction from the primary", async () => {
		const { db, tables } = database;
		const seen = await db.transaction(async (tx) => {
			return tx
				.select({ key: tables.serviceState.key })
				.from(tables.serviceState)
				.where(eq(tables.serviceState.key, "where"));
		});

		expect(seen).toEqual([]);
	});

	it("pings the primary", async () => {
		await expect(database.ping()).resolves.toBeUndefined();
	});
});
