import { createRegistry, MONITORING_FINGERPRINT_KEY } from "@colibri-social/appview/cluster";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countRows } from "./db-copy.js";
import { POLYFILL_PREFIX, type WipeBucket, WipeRefusedError, wipeDatabase } from "./db-wipe.js";

const AT = "2026-11-26T12:00:00.000Z";

const NOW = new Date("2026-11-26T12:00:30.000Z");

let database: TestDatabase;

const fill = async (state: "maintenance" | "active") => {
	const { primary, tables } = database;

	await primary.insert(tables.nodes).values({
		id: "hel-1",
		region: "eu",
		roles: ["main", "api"],
		publicUrl: "https://hel-1.test",
		tailnetUrl: "http://hel-1:3100",
		state,
		registeredAt: AT,
		heartbeatAt: AT,
	});
	await primary.insert(tables.clusterState).values({
		id: "cluster",
		mainNodeId: "hel-1",
		networkParked: true,
		updatedAt: AT,
	});
	await primary.insert(tables.serviceState).values([
		{ key: MONITORING_FINGERPRINT_KEY, value: "fingerprint", updatedAt: AT },
		{ key: "jetstream.cursor", value: "1764158400000000", updatedAt: AT },
	]);
	await primary.insert(tables.messages).values(
		Array.from({ length: 3 }, (_, index) => ({
			space: "at://did:plc:space/social.colibri.beta.channel.text/a",
			author: "did:plc:author",
			rkey: `3lk${String(index).padStart(10, "0")}`,
			community: "did:plc:space",
			text: `message ${index}`,
			createdAt: AT,
			indexedAt: AT,
		})),
	);
};

const fakeBucket = (objects: number): WipeBucket & { deleted: string[] } => {
	const deleted: string[] = [];

	return {
		deleted,
		countPrefix: async () => objects,
		deletePrefix: async (prefix) => {
			deleted.push(prefix);

			return objects;
		},
	};
};

const wipe = (options: { force?: boolean; bucket?: WipeBucket | null } = {}) => {
	return wipeDatabase({
		database,
		registry: createRegistry(database, () => NOW),
		bucket: options.bucket ?? null,
		force: options.force ?? false,
		now: () => NOW,
		beforeWipe: vi.fn(async () => {}),
		print: () => {},
	});
};

beforeEach(async (context) => {
	database = await openTestDatabase();

	if (database.dialect !== "postgres") {
		await database.destroy();
		context.skip();
	}
});

afterEach(async () => {
	await database?.destroy();
});

describe("db wipe", () => {
	it("empties the data and keeps the cluster setup", async () => {
		await fill("maintenance");

		const bucket = fakeBucket(7);
		const plan = await wipe({ bucket });
		const { primary, tables } = database;

		expect(plan.tables).toContainEqual({ table: "messages", rows: 3 });
		expect(plan.objects).toBe(7);
		expect(bucket.deleted).toEqual([POLYFILL_PREFIX]);
		expect(await countRows(database, tables.messages)).toBe(0);
		expect(await countRows(database, tables.nodes)).toBe(1);
		expect(await primary.select().from(tables.clusterState)).toEqual([
			expect.objectContaining({ mainNodeId: "hel-1", networkParked: true }),
		]);
		expect(
			await primary.select({ key: tables.serviceState.key }).from(tables.serviceState),
		).toEqual([{ key: MONITORING_FINGERPRINT_KEY }]);
	});

	it("refuses while the network is up", async () => {
		await fill("maintenance");
		await createRegistry(database).setNetworkParked(false);

		await expect(wipe()).rejects.toThrow(/network down/);
		expect(await countRows(database, database.tables.messages)).toBe(3);
	});

	it("refuses while a node still serves", async () => {
		await fill("active");

		await expect(wipe()).rejects.toThrow(WipeRefusedError);
		await expect(wipe()).rejects.toThrow(/hel-1 \(active\)/);
		expect(await countRows(database, database.tables.messages)).toBe(3);
	});

	it("wipes anyway with force", async () => {
		await fill("active");
		await createRegistry(database).setNetworkParked(false);

		await wipe({ force: true });

		expect(await countRows(database, database.tables.messages)).toBe(0);
	});

	it("stops before the wipe when the confirmation is refused", async () => {
		await fill("maintenance");

		await expect(
			wipeDatabase({
				database,
				registry: createRegistry(database, () => NOW),
				bucket: null,
				force: false,
				now: () => NOW,
				beforeWipe: async () => {
					throw new Error("Cancelled");
				},
				print: () => {},
			}),
		).rejects.toThrow("Cancelled");
		expect(await countRows(database, database.tables.messages)).toBe(3);
	});
});
