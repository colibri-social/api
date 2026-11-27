import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolyfillUsage } from "./usage.js";

const NOW = "2026-11-27T12:00:00.000Z";
const POLYFILLED = "did:plc:polyfilledxxxxxxxxxxxxxxx";
const NATIVE = "did:plc:nativexxxxxxxxxxxxxxxxxxx";
const SPACE =
	"at:space/did:plc:spacexxxxxxxxxxxxxxxxxxxxx/social.colibri.beta.channel.text/general";

let database: TestDatabase;

const record = (author: string, rkey: string, text: string) => {
	return {
		space: SPACE,
		author,
		collection: "social.colibri.beta.channel.message",
		rkey,
		cid: `bafy${rkey}`,
		value: { text },
		indexedAt: NOW,
	};
};

beforeEach(async () => {
	database = await openTestDatabase();

	const { db, tables } = database;

	await db.insert(tables.polyfillActors).values([
		{ did: POLYFILLED, mode: "polyfill", checkedAt: NOW },
		{ did: NATIVE, mode: "native", checkedAt: NOW },
	]);

	await db.insert(tables.polyfillRepos).values([
		{ space: SPACE, author: POLYFILLED, mode: "polyfill", updatedAt: NOW },
		{ space: SPACE, author: NATIVE, mode: "native", updatedAt: NOW },
	]);

	await db
		.insert(tables.records)
		.values([
			record(POLYFILLED, "3mone", "hello"),
			record(NATIVE, "3mtwo", "a much longer message that only the native user wrote"),
		]);

	await db.insert(tables.polyfillBlobs).values([
		{
			cid: "bafyone",
			author: POLYFILLED,
			mime: "image/png",
			size: 1_000,
			s3Key: "one",
			createdAt: NOW,
		},
		{
			cid: "bafytwo",
			author: POLYFILLED,
			mime: "image/png",
			size: 2_500,
			s3Key: "two",
			createdAt: NOW,
		},
	]);
});

afterEach(async () => {
	await database.destroy();
});

describe("createPolyfillUsage", () => {
	it("counts users by mode, blobs and the storage polyfilled repos take", async () => {
		const usage = await createPolyfillUsage(database).read();

		expect(usage.users).toEqual(
			expect.arrayContaining([
				{ mode: "polyfill", count: 1 },
				{ mode: "native", count: 1 },
			]),
		);
		expect(usage.blobs).toBe(2);
		expect(usage.blobBytes).toBe(3_500);
		expect(usage.recordBytes).toBe(JSON.stringify({ text: "hello" }).length);
	});

	it("reuses a measurement until it's five minutes old", async () => {
		let clock = 0;
		const usage = createPolyfillUsage(database, { now: () => clock });

		expect((await usage.read()).blobs).toBe(2);

		await database.db.delete(database.tables.polyfillBlobs);
		expect((await usage.read()).blobs).toBe(2);

		clock += 5 * 60 * 1000;
		expect((await usage.read()).blobs).toBe(0);
	});
});
