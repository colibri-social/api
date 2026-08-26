import type { AddressInfo } from "node:net";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { createTtlCache } from "@colibri-social/embeds";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { ArtworkEntry } from "./activity-artwork.js";
import type { AppContext } from "./context.js";
import { Jetstream } from "./jetstream.js";
import { isLegacyJetstreamUrl, jetstreamEndpoint } from "./jetstream-url.js";

const DID = "did:plc:subjectaaaaaaaaaaaaaaaaaaaa";
const CURSOR_KEY = "jetstream.cursor";

let database: TestDatabase;
let server: WebSocketServer;
let connections: WebSocket[];
let requests: URL[];
let jetstream: Jetstream;

const identityFrame = (seq: number, did = DID) =>
	JSON.stringify({
		$type: "message",
		payload: {
			$type: "network.bsky.jetstream.subscribeEvents#identity",
			did,
			identity: { did, seq: seq + 1_000_000, time: "2026-08-23T01:17:43.936Z" },
			seq,
			time: "2026-08-23T01:17:44.164880Z",
		},
	});

const accountFrame = (seq: number, active: boolean, status?: string) =>
	JSON.stringify({
		$type: "message",
		payload: {
			$type: "network.bsky.jetstream.subscribeEvents#account",
			account: {
				active,
				...(status ? { status } : {}),
				did: DID,
				seq: seq + 1_000_000,
				time: "2026-08-23T01:17:43.936Z",
			},
			did: DID,
			seq,
			time: "2026-08-23T01:17:44.165065Z",
		},
	});

const commitFrame = (
	seq: number,
	collection: string,
	operation: "create" | "update" | "delete",
	record?: Record<string, unknown>,
	did = DID,
) =>
	JSON.stringify({
		$type: "message",
		payload: {
			$type: "network.bsky.jetstream.subscribeEvents#commit",
			did,
			collection,
			operation,
			rkey: "self",
			rev: "3lkrevxxxxxxx",
			...(record ? { record } : {}),
			seq,
			time: "2026-08-23T01:17:44.164880Z",
		},
	});

const cacheProfile = async (colibri: unknown, bsky: unknown, did = DID) => {
	await database.db.insert(database.tables.profileCache).values({
		did,
		colibri: colibri as Record<string, unknown>,
		bsky: bsky as Record<string, unknown>,
		fetchedAt: "2020-01-01T00:00:00.000Z",
	});
};

const cachedProfile = async (did = DID) => {
	const [row] = await database.db
		.select()
		.from(database.tables.profileCache)
		.where(eq(database.tables.profileCache.did, did));
	return row ?? null;
};

const contextFor = (url: string): AppContext =>
	({
		config: {
			JETSTREAM_ENABLED: true,
			JETSTREAM_URL: url,
			PUBLIC_URL: "https://appview.test",
			SIGNING_KEY: "abcdef0123456789",
		},
		database,
		announce: { toUser: () => {}, toCommunity: () => {} },
		artwork: createTtlCache<ArtworkEntry>(),
		identity: { resolveDid: async () => ({ pds: null }) },
		log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
	}) as unknown as AppContext;

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const waitForConnection = async () => {
	for (let attempt = 0; attempt < 100 && connections.length === 0; attempt += 1) await settle();
	if (connections.length === 0) throw new Error("the client never connected");
	return connections[0] as WebSocket;
};

const storedCursor = async () => {
	const [row] = await database.db
		.select()
		.from(database.tables.serviceState)
		.where(eq(database.tables.serviceState.key, CURSOR_KEY));
	return row?.value ?? null;
};

beforeEach(async () => {
	database = await openTestDatabase();
	connections = [];
	requests = [];

	server = new WebSocketServer({ port: 0 });
	server.on("connection", (socket, request) => {
		requests.push(new URL(request.url ?? "/", "http://localhost"));
		connections.push(socket);
	});
	await new Promise((resolve) => server.once("listening", resolve));
});

afterEach(async () => {
	await jetstream?.stop();
	await new Promise((resolve) => server.close(resolve));
	await database.destroy();
});

const startAgainstServer = async (options = {}) => {
	const { port } = server.address() as AddressInfo;
	jetstream = new Jetstream(contextFor(`ws://127.0.0.1:${port}`), options);
	await jetstream.start();
	return waitForConnection();
};

describe("endpoint", () => {
	it("appends the v2 subscription path to a bare host", () => {
		expect(jetstreamEndpoint("wss://jetstream.us-west.bsky.network").toString()).toBe(
			"wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents",
		);
	});

	it("leaves an explicit path alone", () => {
		const explicit = "wss://jetstream.internal/xrpc/network.bsky.jetstream.subscribeEvents";
		expect(jetstreamEndpoint(explicit).toString()).toBe(explicit);
	});

	it("recognises the legacy v1 endpoint", () => {
		expect(isLegacyJetstreamUrl("wss://jetstream1.us-east.bsky.network/subscribe")).toBe(true);
		expect(isLegacyJetstreamUrl("wss://jetstream.us-west.bsky.network")).toBe(false);
	});
});

describe("subscription", () => {
	it("asks for identity, account, profile and listening commits only", async () => {
		await startAgainstServer();
		const request = requests[0] as URL;

		expect(request.pathname).toBe("/xrpc/network.bsky.jetstream.subscribeEvents");
		expect(request.searchParams.getAll("kinds")).toEqual(["commit", "identity", "account"]);
		expect(request.searchParams.getAll("collections")).toEqual([
			"social.colibri.beta.actor.profile",
			"app.bsky.actor.profile",
			"fm.teal.actor.status",
			"fm.teal.alpha.actor.status",
			"app.rocksky.actor.status",
			"fm.atradio.actor.status",
		]);
		expect(request.searchParams.has("wantedCollections")).toBe(false);
	});

	it("negotiates the xrpc.v1.json subprotocol", async () => {
		const socket = await startAgainstServer();
		expect(socket.protocol).toBe("xrpc.v1.json");
	});

	it("resumes from a stored cursor", async () => {
		await database.db.insert(database.tables.serviceState).values({
			key: CURSOR_KEY,
			value: "24990989093",
			updatedAt: new Date().toISOString(),
		});

		await startAgainstServer();
		expect((requests[0] as URL).searchParams.get("cursor")).toBe("24990989093");
	});

	it("carries a legacy microsecond cursor over unchanged", async () => {
		await database.db.insert(database.tables.serviceState).values({
			key: CURSOR_KEY,
			value: "1787443064164880",
			updatedAt: new Date().toISOString(),
		});

		await startAgainstServer();
		expect((requests[0] as URL).searchParams.get("cursor")).toBe("1787443064164880");
	});
});

describe("events", () => {
	it("forgets cached identity and profile rows on an identity event", async () => {
		await database.db.insert(database.tables.identityCache).values({
			did: DID,
			handle: "old.test",
			pds: "https://pds.test",
			signingKey: "did:key:zzz",
			fetchedAt: new Date().toISOString(),
		});

		const identified: string[] = [];
		const socket = await startAgainstServer({
			onIdentity: (did: string) => identified.push(did),
		});

		socket.send(identityFrame(24990989093));
		await settle();

		const rows = await database.db
			.select()
			.from(database.tables.identityCache)
			.where(eq(database.tables.identityCache.did, DID));
		expect(rows).toHaveLength(0);
		expect(identified).toEqual([DID]);
	});

	it("reports an account that is no longer active", async () => {
		const gone: string[] = [];
		const socket = await startAgainstServer({
			onAccountGone: (did: string) => gone.push(did),
		});

		socket.send(accountFrame(24990989096, true));
		await settle();
		expect(gone).toEqual([]);

		socket.send(accountFrame(24990989097, false, "deleted"));
		await settle();
		expect(gone).toEqual([DID]);
	});

	it("ignores a frame that is not a message envelope", async () => {
		const identified: string[] = [];
		const socket = await startAgainstServer({
			onIdentity: (did: string) => identified.push(did),
		});

		socket.send(
			JSON.stringify({
				$type: "error",
				error: "ConsumerTooSlow",
				message: "too slow",
			}),
		);
		socket.send(JSON.stringify({ notAFrame: true }));
		socket.send("this is not json");
		await settle();

		expect(identified).toEqual([]);
	});

	it("does not advance the cursor for an info frame", async () => {
		const socket = await startAgainstServer();

		socket.send(identityFrame(24990989093));
		await settle();
		socket.send(
			JSON.stringify({
				$type: "message",
				payload: {
					$type: "network.bsky.jetstream.subscribeEvents#info",
					name: "OutdatedCursor",
					message: "clamped to the retention floor",
				},
			}),
		);
		await settle();

		await jetstream.stop();
		expect(await storedCursor()).toBe("24990989093");
	});

	it("persists the last cursor it saw when it stops", async () => {
		const socket = await startAgainstServer();

		socket.send(identityFrame(24990989093));
		socket.send(identityFrame(24990989099));
		await settle();
		expect(await storedCursor()).toBeNull();

		await jetstream.stop();
		expect(await storedCursor()).toBe("24990989099");
	});
});

describe("profile commits", () => {
	const COLIBRI = "social.colibri.beta.actor.profile";
	const BSKY = "app.bsky.actor.profile";

	it("replaces the cached colibri profile in place, leaving the bluesky one alone", async () => {
		await cacheProfile({ displayName: "old" }, { displayName: "bsky" });
		const socket = await startAgainstServer();

		socket.send(commitFrame(1, COLIBRI, "update", { $type: COLIBRI, displayName: "new" }));
		await settle();

		const row = await cachedProfile();
		expect(row?.colibri).toMatchObject({ displayName: "new" });
		expect(row?.bsky).toMatchObject({ displayName: "bsky" });
		expect(row?.fetchedAt).not.toBe("2020-01-01T00:00:00.000Z");
	});

	it("replaces the cached bluesky profile without touching the colibri one", async () => {
		await cacheProfile({ displayName: "colibri" }, { displayName: "old" });
		const socket = await startAgainstServer();

		socket.send(commitFrame(1, BSKY, "update", { $type: BSKY, displayName: "new" }));
		await settle();

		const row = await cachedProfile();
		expect(row?.colibri).toMatchObject({ displayName: "colibri" });
		expect(row?.bsky).toMatchObject({ displayName: "new" });
	});

	it("clears the column a delete removed", async () => {
		await cacheProfile({ displayName: "colibri" }, { displayName: "bsky" });
		const socket = await startAgainstServer();

		socket.send(commitFrame(1, COLIBRI, "delete"));
		await settle();

		const row = await cachedProfile();
		expect(row?.colibri).toBeNull();
		expect(row?.bsky).toMatchObject({ displayName: "bsky" });
	});

	it("does not start caching a profile for someone it holds no row for", async () => {
		const socket = await startAgainstServer();

		socket.send(commitFrame(1, COLIBRI, "create", { $type: COLIBRI, displayName: "stranger" }));
		await settle();

		expect(await cachedProfile()).toBeNull();
	});

	it("ignores a commit in a collection it did not ask for", async () => {
		await cacheProfile({ displayName: "colibri" }, { displayName: "bsky" });
		const socket = await startAgainstServer();

		socket.send(commitFrame(1, "app.bsky.feed.post", "create", { text: "hello" }));
		await settle();

		const row = await cachedProfile();
		expect(row?.colibri).toMatchObject({ displayName: "colibri" });
		expect(row?.fetchedAt).toBe("2020-01-01T00:00:00.000Z");
	});

	it("still advances the cursor over a profile commit", async () => {
		const socket = await startAgainstServer();

		socket.send(commitFrame(24990989093, COLIBRI, "update", { $type: COLIBRI }));
		await settle();

		await jetstream.stop();
		expect(await storedCursor()).toBe("24990989093");
	});
});

describe("listening commits", () => {
	const ROCKSKY = "app.rocksky.actor.status";
	const ATRADIO = "fm.atradio.actor.status";

	const shares = () =>
		database.db
			.insert(database.tables.actorSettings)
			.values({ did: DID, shareActivity: true })
			.onConflictDoUpdate({
				target: database.tables.actorSettings.did,
				set: { shareActivity: true },
			});

	const storedActivity = async () => {
		const [row] = await database.db
			.select()
			.from(database.tables.actorActivity)
			.where(eq(database.tables.actorActivity.did, DID));
		return row ?? null;
	};

	it("stores the track a rocksky commit carries", async () => {
		await shares();
		const socket = await startAgainstServer();

		socket.send(
			commitFrame(1, ROCKSKY, "create", {
				$type: ROCKSKY,
				track: {
					name: "The Diary of Jane",
					artist: "Breaking Benjamin",
					durationMs: 200597,
					albumCoverUrl: "https://i.scdn.co/image/ab67616d0000b273742e415e7f4bc3ee0c8ad600",
				},
				startedAt: new Date(Date.now() - 10_000).toISOString(),
			}),
		);
		await settle();

		const row = await storedActivity();
		expect(row?.source).toBe("rocksky.app");
		expect(row?.title).toBe("The Diary of Jane");
	});

	it("stores the station an atradio commit carries", async () => {
		await shares();
		const socket = await startAgainstServer();

		socket.send(
			commitFrame(1, ATRADIO, "create", {
				$type: ATRADIO,
				station: { name: "Rock Antenne", genre: "rock", homepage: "http://www.rockantenne.de/" },
				playedAt: new Date().toISOString(),
			}),
		);
		await settle();

		const row = await storedActivity();
		expect(row?.source).toBe("atradio.fm");
		expect(row?.linkUri).toBe("http://www.rockantenne.de/");
	});

	it("clears the activity when the record is deleted", async () => {
		await shares();
		const socket = await startAgainstServer();

		socket.send(
			commitFrame(1, ATRADIO, "create", {
				$type: ATRADIO,
				station: { name: "Rock Antenne", genre: "rock" },
				playedAt: new Date().toISOString(),
			}),
		);
		await settle();
		expect(await storedActivity()).not.toBeNull();

		socket.send(commitFrame(2, ATRADIO, "delete"));
		await settle();

		expect(await storedActivity()).toBeNull();
	});

	it("stores nothing for someone who does not share their listening", async () => {
		const socket = await startAgainstServer();

		socket.send(
			commitFrame(1, ROCKSKY, "create", {
				$type: ROCKSKY,
				track: {
					name: "The Diary of Jane",
					artist: "Breaking Benjamin",
					albumCoverUrl: "https://i.scdn.co/image/ab67616d0000b273742e415e7f4bc3ee0c8ad600",
				},
				startedAt: new Date().toISOString(),
			}),
		);
		await settle();

		expect(await storedActivity()).toBeNull();
	});
});
