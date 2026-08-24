import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	type ActorAuthz,
	anonymousAuthz,
	type ChannelState,
	type RoleState,
} from "@colibri-social/community";
import { COLLECTIONS, channelSpace, preferencesSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createAuthzChanges } from "../authz-changes.js";
import type { AppContext } from "../context.js";
import { EventServer } from "./events.js";

const EVENTS_PATH = "/xrpc/social.colibri.beta.sync.subscribeEvents";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const ALICE = "did:plc:alicealicealicealicealic";
const BOB = "did:plc:bobbobbobbobbobbobbobbob";

const CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkgeneral");
const OTHER = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkbackstage");

type Frame = Record<string, unknown>;

const memberAuthz = (did: string): ActorAuthz => ({
	actor: did,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: { did, roles: [], joinedAt: "2026-01-01T00:00:00.000Z", nickname: null },
	roles: [],
});

const insiderRole = (): RoleState => ({
	rkey: "3lkinsiders",
	name: "Insiders",
	permissions: [],
	position: 1,
	hoisted: false,
	mentionable: false,
	protected: false,
	channelOverrides: [],
});

const openChannel = (space: string, skey: string): ChannelState => ({
	space,
	skey,
	ownerOnly: false,
	allowedRoles: [],
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
});

const inboxes = new WeakMap<WebSocket, { held: Frame[]; waiting: ((frame: Frame) => void)[] }>();

const watch = (ws: WebSocket): WebSocket => {
	const inbox = { held: [] as Frame[], waiting: [] as ((frame: Frame) => void)[] };
	inboxes.set(ws, inbox);
	ws.on("message", (raw) => {
		const frame = JSON.parse(raw.toString()) as Frame;
		const waiting = inbox.waiting.shift();
		if (waiting) waiting(frame);
		else inbox.held.push(frame);
	});
	return ws;
};

const nextFrame = (ws: WebSocket): Promise<Frame> => {
	const inbox = inboxes.get(ws);
	if (!inbox) throw new Error("this socket is not being watched");
	const held = inbox.held.shift();
	if (held) return Promise.resolve(held);
	return new Promise((resolve) => inbox.waiting.push(resolve));
};

const nextFrameOfType = async (ws: WebSocket, suffix: string): Promise<Frame> => {
	const wanted = `social.colibri.beta.sync.defs#${suffix}`;
	for (;;) {
		const frame = await nextFrame(ws);
		if (frame.$type === wanted) return frame;
	}
};

const heldOfType = (ws: WebSocket, suffix: string): Frame[] =>
	(inboxes.get(ws)?.held ?? []).filter(
		(frame) => frame.$type === `social.colibri.beta.sync.defs#${suffix}`,
	);

const waitForOpen = (ws: WebSocket): Promise<void> =>
	new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});

const send = (ws: WebSocket, frame: Frame): void => {
	ws.send(JSON.stringify(frame));
};

describe("EventServer", () => {
	let database: TestDatabase;
	let http: Server;
	let events: EventServer;
	let port: number;
	let notifyWrite: ReturnType<typeof vi.fn>;
	let channels: Map<string, ChannelState>;
	let authz: Map<string, ActorAuthz>;
	let authzChanges: ReturnType<typeof createAuthzChanges>;

	const buildCtx = (): AppContext => {
		channels = new Map<string, ChannelState>([
			[CHANNEL, openChannel(CHANNEL, "3lkgeneral")],
			[OTHER, openChannel(OTHER, "3lkbackstage")],
		]);
		authz = new Map<string, ActorAuthz>([
			[ALICE, memberAuthz(ALICE)],
			[BOB, memberAuthz(BOB)],
		]);
		authzChanges = createAuthzChanges();
		const tokens = new Map<string, string>([
			["alice-token", ALICE],
			["bob-token", BOB],
		]);

		return {
			database,
			log: { warn: () => {}, debug: () => {}, error: () => {} },
			sync: { notifyWrite },
			voice: null,
			serviceAuth: {
				verify: async (token: string, lxm: string | null) => {
					const did = tokens.get(token);
					if (!did) throw new Error("invalid token");
					return { did, lxm };
				},
			},
			authzChanges,
			loader: {
				channel: async (space: string) => channels.get(space) ?? null,
				authz: async (community: string, actor: string) =>
					authz.get(actor) ?? anonymousAuthz(actor, community),
			},
		} as unknown as AppContext;
	};

	const connect = (token: string): WebSocket =>
		watch(
			new WebSocket(`ws://127.0.0.1:${port}${EVENTS_PATH}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

	const subscribed = async (ws: WebSocket, channel: string): Promise<Frame> => {
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			channels: [channel],
		});
		return nextFrameOfType(ws, "subscribed");
	};

	const viewingChannelOf = async (did: string): Promise<string | null | undefined> => {
		const [row] = await database.db
			.select({ viewingChannel: database.tables.userPresence.viewingChannel })
			.from(database.tables.userPresence)
			.where(eq(database.tables.userPresence.did, did))
			.limit(1);
		return row?.viewingChannel;
	};

	const putChannelRow = async (
		space: string,
		skey: string,
		visibleToRoles: string[] = [],
	): Promise<void> => {
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey,
			name: skey,
			position: 0,
			ownerOnly: false,
			allowedRoles: [],
			allowedMembers: [],
			visibleToRoles,
			visibleToMembers: [],
		});
	};

	beforeEach(async () => {
		database = await openTestDatabase();
		notifyWrite = vi.fn();
		http = createServer();
		events = new EventServer(buildCtx());
		events.attach(http);
		port = await new Promise<number>((resolve) => {
			http.listen(0, () => resolve((http.address() as AddressInfo).port));
		});
	});

	afterEach(async () => {
		await events.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await database.destroy();
	});

	it("grants a subscription to a channel the caller can read", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		expect(await subscribed(ws, CHANNEL)).toMatchObject({
			$type: "social.colibri.beta.sync.defs#subscribed",
			channels: [CHANNEL],
		});

		ws.close();
	});

	it("grants a community's readable channels without naming them", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");
		await putChannelRow(OTHER, "3lkbackstage", ["3lkinsiders"]);

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});

		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({
			communities: [COMMUNITY],
			channels: [CHANNEL],
		});

		ws.close();
	});

	it("drops a community's channels when the community is unsubscribed", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		await nextFrameOfType(ws, "subscribed");

		send(ws, {
			$type: "social.colibri.beta.sync.defs#unsubscribe",
			communities: [COMMUNITY],
		});

		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({
			communities: [],
			channels: [],
		});

		ws.close();
	});

	it("hands over a channel that a granted role just made readable", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");
		await putChannelRow(OTHER, "3lkbackstage", ["3lkinsiders"]);

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		await nextFrameOfType(ws, "subscribed");

		authz.set(ALICE, { ...memberAuthz(ALICE), roles: [insiderRole()] });
		authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.member });

		expect(await nextFrameOfType(ws, "channelEvent")).toMatchObject({
			event: "create",
			community: COMMUNITY,
			space: OTHER,
		});
		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({
			channels: [CHANNEL, OTHER],
		});

		ws.close();
	});

	it("hands over a channel that was just created", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		await nextFrameOfType(ws, "subscribed");

		await putChannelRow(OTHER, "3lkbackstage");
		authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.channel });

		expect(await nextFrameOfType(ws, "channelEvent")).toMatchObject({
			event: "create",
			community: COMMUNITY,
			space: OTHER,
		});

		ws.close();
	});

	it("takes back a channel that a revoked role made unreadable", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");
		await putChannelRow(OTHER, "3lkbackstage", ["3lkinsiders"]);
		authz.set(ALICE, { ...memberAuthz(ALICE), roles: [insiderRole()] });

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({
			channels: [CHANNEL, OTHER],
		});

		authz.set(ALICE, memberAuthz(ALICE));
		authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.member });

		expect(await nextFrameOfType(ws, "channelEvent")).toMatchObject({
			event: "delete",
			community: COMMUNITY,
			space: OTHER,
		});
		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({
			channels: [CHANNEL],
		});

		ws.close();
	});

	it("keeps a private channel's update away from anyone outside its audience", async () => {
		await putChannelRow(OTHER, "3lkbackstage", ["3lkinsiders"]);

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		await nextFrameOfType(ws, "subscribed");

		events.channelChanged(COMMUNITY, OTHER, "update");
		await vi.waitFor(() => expect(events.connectionCount).toBe(1));

		expect(heldOfType(ws, "channelEvent")).toEqual([]);

		ws.close();
	});

	it("stops delivering a channel once it is deleted", async () => {
		await putChannelRow(CHANNEL, "3lkgeneral");

		const ws = connect("alice-token");
		await waitForOpen(ws);
		send(ws, {
			$type: "social.colibri.beta.sync.defs#subscribe",
			communities: [COMMUNITY],
		});
		await nextFrameOfType(ws, "subscribed");

		events.channelChanged(COMMUNITY, CHANNEL, "delete");

		expect(await nextFrameOfType(ws, "channelEvent")).toMatchObject({
			event: "delete",
			space: CHANNEL,
		});
		expect(await nextFrameOfType(ws, "subscribed")).toMatchObject({ channels: [] });

		ws.close();
	});

	it("passes a typing frame to the others in the channel", async () => {
		const alice = connect("alice-token");
		const bob = connect("bob-token");
		await Promise.all([waitForOpen(alice), waitForOpen(bob)]);
		await subscribed(alice, CHANNEL);
		await subscribed(bob, CHANNEL);

		send(alice, { $type: "social.colibri.beta.sync.defs#typing", channel: CHANNEL });

		expect(await nextFrameOfType(bob, "typingEvent")).toEqual({
			$type: "social.colibri.beta.sync.defs#typingEvent",
			did: ALICE,
			channel: CHANNEL,
		});

		alice.close();
		bob.close();
	});

	it("does not echo a typing frame back to whoever is typing", async () => {
		const alice = connect("alice-token");
		const bob = connect("bob-token");
		await Promise.all([waitForOpen(alice), waitForOpen(bob)]);
		await subscribed(alice, CHANNEL);
		await subscribed(bob, CHANNEL);

		send(alice, { $type: "social.colibri.beta.sync.defs#typing", channel: CHANNEL });
		await nextFrameOfType(bob, "typingEvent");

		expect(heldOfType(alice, "typingEvent")).toEqual([]);

		alice.close();
		bob.close();
	});

	it("ignores typing in a channel the caller never subscribed to", async () => {
		const alice = connect("alice-token");
		const bob = connect("bob-token");
		await Promise.all([waitForOpen(alice), waitForOpen(bob)]);
		await subscribed(bob, OTHER);

		send(alice, { $type: "social.colibri.beta.sync.defs#typing", channel: OTHER });
		await vi.waitFor(() => expect(events.connectionCount).toBe(2));

		expect(heldOfType(bob, "typingEvent")).toEqual([]);

		alice.close();
		bob.close();
	});

	it("pulls a channel the caller hinted it just wrote to", async () => {
		const alice = connect("alice-token");
		await waitForOpen(alice);
		await subscribed(alice, CHANNEL);

		const rev = nextTid();
		send(alice, { $type: "social.colibri.beta.sync.defs#wroteTo", space: CHANNEL, rev });

		await vi.waitFor(() =>
			expect(notifyWrite).toHaveBeenCalledWith(
				CHANNEL,
				ALICE,
				expect.objectContaining({ trigger: "clientHint", rev }),
			),
		);

		alice.close();
	});

	it("ignores a write hint for a channel the caller never subscribed to", async () => {
		const alice = connect("alice-token");
		await waitForOpen(alice);
		await subscribed(alice, CHANNEL);

		send(alice, { $type: "social.colibri.beta.sync.defs#wroteTo", space: OTHER });
		send(alice, { $type: "social.colibri.beta.sync.defs#typing", channel: CHANNEL });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(notifyWrite).not.toHaveBeenCalled();

		alice.close();
	});

	it("pulls the caller's own personal space without a subscription", async () => {
		const alice = connect("alice-token");
		await waitForOpen(alice);

		send(alice, {
			$type: "social.colibri.beta.sync.defs#wroteTo",
			space: preferencesSpace(ALICE),
		});

		await vi.waitFor(() =>
			expect(notifyWrite).toHaveBeenCalledWith(
				preferencesSpace(ALICE),
				ALICE,
				expect.objectContaining({ trigger: "clientHint" }),
			),
		);

		alice.close();
	});

	it("rate limits a client that floods write hints", async () => {
		const alice = connect("alice-token");
		await waitForOpen(alice);
		await subscribed(alice, CHANNEL);

		for (let sent = 0; sent < 25; sent += 1) {
			send(alice, { $type: "social.colibri.beta.sync.defs#wroteTo", space: CHANNEL });
		}

		expect(await nextFrameOfType(alice, "error")).toMatchObject({ error: "RateLimited" });
		expect(notifyWrite.mock.calls.length).toBeLessThanOrEqual(20);

		alice.close();
	});

	it("remembers which channel someone is looking at, and forgets it when they go", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);
		await vi.waitFor(async () => expect(await viewingChannelOf(ALICE)).toBeNull());

		send(ws, { $type: "social.colibri.beta.sync.defs#viewChannel", channel: CHANNEL });
		await vi.waitFor(async () => expect(await viewingChannelOf(ALICE)).toBe(CHANNEL));

		ws.close();
		await vi.waitFor(async () => expect(await viewingChannelOf(ALICE)).toBeNull());
	});

	it("clears the channel in view when the client names none", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.sync.defs#viewChannel", channel: CHANNEL });
		await vi.waitFor(async () => expect(await viewingChannelOf(ALICE)).toBe(CHANNEL));

		send(ws, { $type: "social.colibri.beta.sync.defs#viewChannel" });
		await vi.waitFor(async () => expect(await viewingChannelOf(ALICE)).toBeNull());

		ws.close();
	});
});
