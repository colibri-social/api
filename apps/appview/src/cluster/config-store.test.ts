import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStore, createConfigStore, isSharedKey } from "./config-store.js";

let database: TestDatabase;
let store: ConfigStore;

beforeEach(async () => {
	database = await openTestDatabase();
	store = createConfigStore(database, await SecretBox.fromBase64(SecretBox.generateKeyBase64()));
});

afterEach(async () => {
	await database.destroy();
});

describe("isSharedKey", () => {
	it("shares settings every node needs and keeps node settings local", () => {
		expect(isSharedKey("SIGNING_KEY")).toBe(true);
		expect(isSharedKey("NODE_ID")).toBe(false);
		expect(isSharedKey("DATABASE_READ_URL")).toBe(false);
		expect(isSharedKey("NOT_A_SETTING")).toBe(false);
	});
});

describe("createConfigStore", () => {
	it("stores values encrypted and reads them back", async () => {
		await store.set("SIGNING_KEY", "a".repeat(64));
		await store.set("PDS_URL", "https://pds.test");

		const [row] = await database.db.select().from(database.tables.clusterConfig).limit(1);

		expect(row?.ciphertext).not.toContain("pds.test");
		expect(await store.keys()).toEqual(["PDS_URL", "SIGNING_KEY"]);
		expect(await store.values()).toEqual({
			PDS_URL: "https://pds.test",
			SIGNING_KEY: "a".repeat(64),
		});
	});

	it("replaces and removes values", async () => {
		await store.set("PDS_URL", "https://old.test");
		await store.set("PDS_URL", "https://new.test");

		expect(await store.values()).toEqual({ PDS_URL: "https://new.test" });
		expect(await store.unset("PDS_URL")).toBe(true);
		expect(await store.unset("PDS_URL")).toBe(false);
		expect(await store.keys()).toEqual([]);
	});

	it("refuses node-local settings", async () => {
		await expect(store.set("NODE_ID", "eu-2")).rejects.toThrow(/not a setting every node shares/);
	});
});
