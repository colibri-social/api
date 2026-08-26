import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { handleGetProfile } from "./actor.js";

const CALLER = "did:plc:callerxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
const PDS = "https://pds.test";

let database: TestDatabase;
let ctx: AppContext;
let actors: ActorViews;

const seedCache = (did: string, displayName: string) =>
	database.db.insert(database.tables.profileCache).values({
		did,
		colibri: { displayName, syncBluesky: false },
		bsky: null,
		fetchedAt: new Date().toISOString(),
	});

const servePdsRecord = (displayName: string) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(typeof input === "string" ? input : (input as Request).url);
		if (url.searchParams.get("collection") !== COLLECTIONS.profile)
			return new Response("not found", { status: 404 });
		return Response.json({ value: { displayName, syncBluesky: false } });
	});

beforeEach(async () => {
	database = await openTestDatabase();
	ctx = {
		config: { PUBLIC_URL: "https://appview.test" },
		database,
		identity: {
			resolveDid: async () => ({ pds: PDS }),
			resolveVerifiedHandle: async () => "caller.test",
			resolveVerifiedHandles: async (dids: readonly string[]) =>
				new Map(dids.map((did) => [did, "caller.test"])),
			resolveAtIdentifier: async () => ({ did: CALLER }),
		},
		voice: undefined,
	} as unknown as AppContext;
	actors = new ActorViews(ctx);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await database.destroy();
});

describe("getProfile freshness", () => {
	it("refetches the caller's own profile past the cache window", async () => {
		await seedCache(CALLER, "Stale Name");
		servePdsRecord("Fresh Name");

		const { profile } = await handleGetProfile(ctx, actors, CALLER, CALLER);

		expect(profile.displayName).toBe("Fresh Name");
	});

	it("writes the refetched profile back to the cache", async () => {
		await seedCache(CALLER, "Stale Name");
		servePdsRecord("Fresh Name");

		await handleGetProfile(ctx, actors, CALLER, CALLER);
		const [row] = await database.db.select().from(database.tables.profileCache);

		expect(row?.colibri).toMatchObject({ displayName: "Fresh Name" });
	});

	it("serves someone else's profile from the cache", async () => {
		await seedCache(OTHER, "Cached Name");
		const fetchSpy = servePdsRecord("Fresh Name");

		const { profile } = await handleGetProfile(ctx, actors, OTHER, CALLER);

		expect(profile.displayName).toBe("Cached Name");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("still uses the cache when there is no caller", async () => {
		await seedCache(CALLER, "Cached Name");
		const fetchSpy = servePdsRecord("Fresh Name");

		const { profile } = await handleGetProfile(ctx, actors, CALLER);

		expect(profile.displayName).toBe("Cached Name");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
