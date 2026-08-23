import type { AddressInfo } from "node:net";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
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

const contextFor = (url: string): AppContext =>
	({
		config: { JETSTREAM_ENABLED: true, JETSTREAM_URL: url },
		database,
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
	it("asks only for identity and account events", async () => {
		await startAgainstServer();
		const request = requests[0] as URL;

		expect(request.pathname).toBe("/xrpc/network.bsky.jetstream.subscribeEvents");
		expect(request.searchParams.getAll("kinds")).toEqual(["identity", "account"]);
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
