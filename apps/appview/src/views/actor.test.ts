import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { COLLECTIONS } from "@colibri-social/lexicons";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "./actor.js";

const ACTOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const PDS = "https://pds.test";
const AVATAR_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";
const STALE = "2026-01-01T00:00:00.000Z";

let database: TestDatabase;
let views: ActorViews;

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const respondWith = (handler: (collection: string) => Response) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			return handler(url.searchParams.get("collection") ?? "");
		}),
	);
};

const cachedRow = async () => {
	const rows = await database.db
		.select()
		.from(database.tables.profileCache)
		.where(eq(database.tables.profileCache.did, ACTOR));
	return rows[0];
};

beforeEach(async () => {
	database = await openTestDatabase();
	const ctx = {
		database,
		log: { warn: () => {} },
		config: { PUBLIC_URL: "https://appview.test", PROFILE_FETCH_CONCURRENCY: 4 },
		identity: {
			resolveDid: async () => ({ pds: PDS }),
			resolveVerifiedHandles: async () => new Map([[ACTOR, "alice.test"]]),
		},
	} as unknown as AppContext;
	views = new ActorViews(ctx);

	await database.db.insert(database.tables.profileCache).values({
		did: ACTOR,
		colibri: {
			displayName: "Alice",
			avatar: { $type: "blob", ref: { $link: AVATAR_CID }, mimeType: "image/png", size: 1 },
			syncBluesky: false,
		},
		bsky: null,
		fetchedAt: STALE,
	});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await database.destroy();
});

const forgetCachedRow = () =>
	database.db
		.delete(database.tables.profileCache)
		.where(eq(database.tables.profileCache.did, ACTOR));

describe("ActorViews.hydrate", () => {
	it("keeps the cached profile when the PDS fetch fails", async () => {
		respondWith(() => json(429, { error: "RateLimitExceeded", message: "slow down" }));

		const profile = await views.one(ACTOR);

		expect(profile.displayName).toBe("Alice");
		expect(profile.avatar).toContain(AVATAR_CID);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect((await cachedRow())?.fetchedAt).toBe(STALE);
	});

	it("serves a stale profile at once and refreshes it in the background", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				await held;
				const url = new URL(input instanceof Request ? input.url : input.toString());
				return url.searchParams.get("collection") === COLLECTIONS.profile
					? json(200, { value: { displayName: "Alice Updated", syncBluesky: false } })
					: json(400, { error: "RecordNotFound", message: "not found" });
			}),
		);

		const first = await views.one(ACTOR);
		const second = await views.one(ACTOR);

		expect(first.displayName).toBe("Alice");
		expect(second.displayName).toBe("Alice");
		release();
		await vi.waitFor(async () => expect((await cachedRow())?.fetchedAt).not.toBe(STALE));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect((await views.one(ACTOR)).displayName).toBe("Alice Updated");
	});

	it("treats a missing record as an empty profile and caches it", async () => {
		await forgetCachedRow();
		respondWith((collection) =>
			collection === COLLECTIONS.profile
				? json(200, { value: { displayName: "Alice Updated", syncBluesky: false } })
				: json(400, { error: "RecordNotFound", message: "not found" }),
		);

		const profile = await views.one(ACTOR);

		expect(profile.displayName).toBe("Alice Updated");
		expect(profile.avatar).toBeUndefined();
		const row = await cachedRow();
		expect(row?.fetchedAt).not.toBe(STALE);
		expect(row?.bsky).toBeNull();
	});

	it.each([
		{
			name: "uses the record's pronouns",
			colibri: { pronouns: "she/her", syncBluesky: false },
			bsky: { pronouns: "they/them" },
			expected: "she/her",
		},
		{
			name: "ignores Bluesky pronouns without sync",
			colibri: { syncBluesky: false },
			bsky: { pronouns: "they/them" },
			expected: undefined,
		},
		{
			name: "falls back to Bluesky pronouns while synced",
			colibri: { syncBluesky: true },
			bsky: { pronouns: "they/them" },
			expected: "they/them",
		},
		{
			name: "prefers the record's pronouns while synced",
			colibri: { pronouns: "she/her", syncBluesky: true },
			bsky: { pronouns: "they/them" },
			expected: "she/her",
		},
		{
			name: "uses Bluesky pronouns without a Colibri record",
			colibri: null,
			bsky: { pronouns: "he/him" },
			expected: "he/him",
		},
	])("$name", async ({ colibri, bsky, expected }) => {
		await forgetCachedRow();
		respondWith((collection) => {
			const value = collection === COLLECTIONS.profile ? colibri : bsky;
			return value
				? json(200, { value })
				: json(400, { error: "RecordNotFound", message: "not found" });
		});

		const profile = await views.one(ACTOR);

		expect(profile.pronouns).toBe(expected);
	});
});

describe("resolveMessageAuthor", () => {
	const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
	const SPACE = `at://${COMMUNITY}/social.colibri.beta.channel.text/3lkchannelaaaa`;
	const VIEWER = "did:plc:viewerxxxxxxxxxxxxxxxxxxxxxx";
	const community = {
		did: COMMUNITY,
		handle: "community.test",
		displayName: "Community",
		isBot: false,
		syncBluesky: false,
	} as never;
	const bridged = {
		registration: "3lkbridgeaaaa",
		platform: "chat",
		remoteId: "ruth-1",
		name: "Remote Ruth",
		avatar: { $type: "blob", ref: { $link: AVATAR_CID }, mimeType: "image/png", size: 1 },
	};
	const resolver = () =>
		new ActorViews({
			config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "c".repeat(64) },
		} as unknown as AppContext);

	it("swaps in the remote author with an avatar signed for the viewer", () => {
		const author = resolver().resolveMessageAuthor(
			{ author: COMMUNITY, community: COMMUNITY, bridged },
			community,
			SPACE,
			VIEWER,
		);

		expect(author?.displayName).toBe("Remote Ruth");
		expect(author?.bridge?.remoteId).toBe("ruth-1");
		const avatar = new URL(author?.avatar ?? "");
		expect(avatar.searchParams.get("did")).toBe(COMMUNITY);
		expect(avatar.searchParams.get("space")).toBe(SPACE);
		expect(avatar.searchParams.get("viewer")).toBe(VIEWER);
		expect(avatar.searchParams.get("sig")).toBeTruthy();
	});

	it("leaves the avatar unsigned when there is no viewer", () => {
		const author = resolver().resolveMessageAuthor(
			{ author: COMMUNITY, community: COMMUNITY, bridged },
			community,
			SPACE,
			null,
		);

		expect(new URL(author?.avatar ?? "").searchParams.has("sig")).toBe(false);
	});

	it("keeps the profile for a message the community did not write", () => {
		const author = resolver().resolveMessageAuthor(
			{ author: ACTOR, community: COMMUNITY, bridged },
			community,
			SPACE,
			VIEWER,
		);

		expect(author).toBe(community);
	});
});
