import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ActorAuthz, anonymousAuthz, type ChannelState } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { VoiceSfu, type WorkerPoolLike } from "@colibri-social/voice";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { asRouter, createFakeRouter } from "../../../../packages/voice/src/mock-mediasoup.js";
import { type AuthzChanges, createAuthzChanges } from "../authz-changes.js";
import type { AppContext } from "../context.js";
import type { EventServer } from "./events.js";
import { VoiceServer } from "./voice.js";

const VOICE_PATH = "/xrpc/social.colibri.beta.voice.subscribeSignals";

const COMMUNITY = "did:plc:community";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const MALLORY = "did:plc:mallory";

const VOICE_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "general");
const OTHER_VOICE_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "lounge");
const TEXT_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "chat");

const memberAuthz = (did: string): ActorAuthz => ({
	actor: did,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: { did, roles: [], joinedAt: "2026-01-01T00:00:00.000Z", nickname: null },
	roles: [],
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

const fakeWorkerPool = (): WorkerPoolLike => ({
	createRouter: async () => asRouter(createFakeRouter()),
	close: async () => {},
});

type Harness = {
	ctx: AppContext;
	authzChanges: AuthzChanges;
	channels: Map<string, ChannelState>;
	authz: Map<string, ActorAuthz>;
};

const buildCtx = (voice: VoiceSfu | null): Harness => {
	const channels = new Map<string, ChannelState>([
		[VOICE_CHANNEL, openChannel(VOICE_CHANNEL, "general")],
		[OTHER_VOICE_CHANNEL, openChannel(OTHER_VOICE_CHANNEL, "lounge")],
		[TEXT_CHANNEL, openChannel(TEXT_CHANNEL, "chat")],
	]);
	const authz = new Map<string, ActorAuthz>([
		[ALICE, memberAuthz(ALICE)],
		[BOB, memberAuthz(BOB)],
	]);
	const tokens = new Map<string, string>([
		["alice-token", ALICE],
		["bob-token", BOB],
		["mallory-token", MALLORY],
	]);
	const authzChanges = createAuthzChanges();

	const ctx = {
		voice,
		authzChanges,
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		serviceAuth: {
			verify: async (token: string, lxm: string | null) => {
				const did = tokens.get(token);
				if (!did) throw new Error("invalid token");
				return { did, lxm };
			},
		},
		loader: {
			channel: async (space: string) => channels.get(space) ?? null,
			authz: async (community: string, actor: string) =>
				authz.get(actor) ?? anonymousAuthz(actor, community),
		},
	} as unknown as AppContext;

	return { ctx, authzChanges, channels, authz };
};

const listen = (http: Server): Promise<number> =>
	new Promise((resolve) => {
		http.listen(0, () => resolve((http.address() as AddressInfo).port));
	});

const waitForOpen = (ws: WebSocket): Promise<void> =>
	new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});

type Frame = Record<string, unknown>;

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
	const wanted = `social.colibri.beta.voice.defs#${suffix}`;
	for (;;) {
		const frame = await nextFrame(ws);
		if (frame.$type === wanted) return frame;
	}
};

const send = (ws: WebSocket, frame: Record<string, unknown>): void => {
	ws.send(JSON.stringify(frame));
};

describe("VoiceServer", () => {
	let sfu: VoiceSfu;
	let http: Server;
	let voiceServer: VoiceServer;
	let port: number;
	let harness: Harness;
	let announced: Array<{ community: string; frame: Record<string, unknown> }>;

	beforeEach(async () => {
		sfu = await VoiceSfu.create({ roomGraceMs: 1_000 }, { workerPool: fakeWorkerPool() });
		announced = [];
		harness = buildCtx(sfu);
		voiceServer = new VoiceServer(harness.ctx, {
			publishToCommunity: (community: string, frame: Record<string, unknown>) => {
				announced.push({ community, frame });
			},
		} as unknown as EventServer);
		http = createServer();
		voiceServer.attach(http);
		port = await listen(http);
	});

	afterEach(async () => {
		await voiceServer.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await sfu.close();
	});

	const connect = (token: string): WebSocket =>
		watch(
			new WebSocket(`ws://127.0.0.1:${port}${VOICE_PATH}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

	it("rejects an upgrade without a valid service auth token", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_PATH}`);
		const status = await new Promise<number | undefined>((resolve) => {
			ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
		});
		expect(status).toBe(401);
	});

	it("refuses the upgrade when voice is disabled", async () => {
		const disabledServer = new VoiceServer(buildCtx(null).ctx);
		const disabledHttp = createServer();
		disabledServer.attach(disabledHttp);
		const disabledPort = await listen(disabledHttp);

		const ws = new WebSocket(`ws://127.0.0.1:${disabledPort}${VOICE_PATH}`, {
			headers: { authorization: "Bearer alice-token" },
		});
		const status = await new Promise<number | undefined>((resolve) => {
			ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
		});
		expect(status).toBe(503);

		await disabledServer.close();
		await new Promise<void>((resolve) => disabledHttp.close(() => resolve()));
	});

	it("rejects a frame sent before joining", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#getRtpCapabilities" });
		const frame = await nextFrame(ws);

		expect(frame).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "NotJoined",
		});
		ws.close();
	});

	it("rejects joining a channel that is not a voice channel", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: TEXT_CHANNEL });
		const frame = await nextFrame(ws);

		expect(frame).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "NotVoiceChannel",
		});
		ws.close();
	});

	it("rejects joining a voice channel the caller cannot read", async () => {
		const ws = connect("mallory-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		const frame = await nextFrame(ws);

		expect(frame).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "Forbidden",
		});
		ws.close();
	});

	it("rejects joining a voice channel the caller may read but not speak in", async () => {
		harness.channels.set(VOICE_CHANNEL, {
			...openChannel(VOICE_CHANNEL, "general"),
			allowedRoles: ["speakers"],
		});

		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });

		expect(await nextFrame(ws)).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "Forbidden",
		});
		ws.close();
	});

	it("joins a voice channel, creates a transport, and produces", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		const joined = await nextFrame(ws);
		expect(joined).toEqual({
			$type: "social.colibri.beta.voice.defs#joined",
			channel: VOICE_CHANNEL,
		});

		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(ws);
		expect(transport.$type).toBe("social.colibri.beta.voice.defs#transportOptions");
		expect(transport.direction).toBe("send");

		send(ws, {
			$type: "social.colibri.beta.voice.defs#connectTransport",
			transportId: transport.id,
			dtlsParameters: {},
		});
		expect(await nextFrame(ws)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});
		const produced = await nextFrame(ws);

		expect(produced).toMatchObject({
			$type: "social.colibri.beta.voice.defs#producerInfo",
			did: ALICE,
			kind: "audio",
			source: "microphone",
		});

		ws.close();
	});

	it("answers every frame a client waits on, so its reply queue keeps moving", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(ws);

		send(ws, {
			$type: "social.colibri.beta.voice.defs#connectTransport",
			transportId: transport.id,
			dtlsParameters: {},
		});
		expect(await nextFrame(ws)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});
		const produced = await nextFrame(ws);

		send(ws, {
			$type: "social.colibri.beta.voice.defs#closeProducer",
			producerId: produced.producerId,
		});
		expect(await nextFrame(ws)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });

		send(ws, { $type: "social.colibri.beta.voice.defs#setSelfState", deafened: true });
		expect((await nextFrame(ws)).$type).toBe("social.colibri.beta.voice.defs#moderationChanged");
		expect(await nextFrame(ws)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });

		ws.close();
	});

	it("tells other peers in the channel about a new producer", async () => {
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(bobWs);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(aliceWs);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(aliceWs);

		const bobNotification = nextFrameOfType(bobWs, "producerInfo");

		send(aliceWs, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});
		await nextFrameOfType(aliceWs, "producerInfo");

		const notification = await bobNotification;
		expect(notification).toMatchObject({
			$type: "social.colibri.beta.voice.defs#producerInfo",
			did: ALICE,
			kind: "audio",
			source: "microphone",
		});

		aliceWs.close();
		bobWs.close();
	});

	it("refuses to produce audio for a server-muted peer", async () => {
		await sfu.rtpCapabilities(VOICE_CHANNEL);
		await sfu.moderate(VOICE_CHANNEL, ALICE, { muted: true });

		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(ws);

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});
		const frame = await nextFrame(ws);

		expect(frame).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "Forbidden",
		});
		ws.close();
	});

	it("keeps refusing audio after a server-muted peer tries to unmute itself", async () => {
		await sfu.rtpCapabilities(VOICE_CHANNEL);
		await sfu.moderate(VOICE_CHANNEL, ALICE, { muted: true });

		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#setSelfState", muted: false });
		const changed = await nextFrame(ws);
		expect(changed).toMatchObject({
			$type: "social.colibri.beta.voice.defs#moderationChanged",
			muted: true,
			serverMuted: true,
		});
		expect(sfu.getVoiceState(VOICE_CHANNEL, ALICE)).toMatchObject({
			muted: true,
			serverMuted: true,
		});
		expect(await nextFrame(ws)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});

		expect(await nextFrame(ws)).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
			error: "Forbidden",
		});
		ws.close();
	});

	it("announces a join and a state change to the community, so the sidebar sees it", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(ws);

		expect(announced).toEqual([
			{
				community: COMMUNITY,
				frame: {
					$type: "social.colibri.beta.sync.defs#voiceEvent",
					event: "join",
					channel: VOICE_CHANNEL,
					did: ALICE,
					voice: {
						channel: VOICE_CHANNEL,
						muted: false,
						deafened: false,
						serverMuted: false,
						serverDeafened: false,
					},
				},
			},
		]);

		await sfu.moderate(VOICE_CHANNEL, ALICE, { muted: true });
		expect(announced.at(-1)).toMatchObject({
			community: COMMUNITY,
			frame: {
				event: "update",
				did: ALICE,
				voice: { muted: true, serverMuted: true },
			},
		});

		ws.close();
	});

	it("leaves the sfu room when the socket disconnects", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(ws);

		expect(sfu.presenceOf(ALICE)).toBe(VOICE_CHANNEL);

		const left = new Promise<void>((resolve) => sfu.once("participant-left", () => resolve()));
		ws.close();
		await left;

		expect(sfu.presenceOf(ALICE)).toBeUndefined();
	});

	it("tells the peer why the sfu removed it, and nobody else", async () => {
		await sfu.rtpCapabilities(VOICE_CHANNEL);
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(aliceWs);
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(aliceWs);
		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(bobWs);
		send(bobWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(bobWs);

		const left = new Promise<void>((resolve) => sfu.once("participant-left", () => resolve()));
		await sfu.leave(VOICE_CHANNEL, ALICE, "channelGone");
		await left;

		expect(await nextFrameOfType(aliceWs, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "channelGone",
		});
		expect(await nextFrameOfType(bobWs, "peerLeft")).toMatchObject({ did: ALICE });

		aliceWs.close();
		bobWs.close();
	});

	it("says nothing to a peer that left on its own", async () => {
		await sfu.rtpCapabilities(VOICE_CHANNEL);
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(ws);

		const left = new Promise<void>((resolve) => sfu.once("participant-left", () => resolve()));
		send(ws, { $type: "social.colibri.beta.voice.defs#leave" });
		await left;

		expect(
			(inboxes.get(ws)?.held ?? []).filter(
				(frame) => frame.$type === "social.colibri.beta.voice.defs#disconnected",
			),
		).toEqual([]);

		ws.close();
	});

	it("disconnects a participant whose access is revoked mid-call", async () => {
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(aliceWs);
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(aliceWs);
		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(bobWs);

		harness.authz.set(ALICE, { ...memberAuthz(ALICE), isBanned: true });
		harness.authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.moderation });

		expect(await nextFrameOfType(aliceWs, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "forbidden",
		});
		expect(await nextFrameOfType(bobWs, "peerLeft")).toMatchObject({ did: ALICE });
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(false);
		expect(voiceServer.isJoined(VOICE_CHANNEL, BOB)).toBe(true);

		aliceWs.close();
		bobWs.close();
	});

	it("disconnects a participant once its channel is gone", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		harness.channels.delete(VOICE_CHANNEL);
		harness.authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.channel });

		expect(await nextFrameOfType(ws, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "channelGone",
		});
		ws.close();
	});

	it("keeps a participant whose access survives an authz change", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		harness.authzChanges.publish({ community: COMMUNITY, collection: COLLECTIONS.role });
		await voiceServer.revalidate(COMMUNITY);

		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(true);
		expect(
			(inboxes.get(ws)?.held ?? []).filter(
				(frame) => frame.$type === "social.colibri.beta.voice.defs#disconnected",
			),
		).toEqual([]);

		ws.close();
	});

	it("disconnects a peer that joined but never created a transport", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		expect(sfu.presenceOf(ALICE)).toBeUndefined();
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(true);

		await voiceServer.disconnect(VOICE_CHANNEL, ALICE);

		expect(await nextFrameOfType(ws, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "moderator",
		});
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(false);

		ws.close();
	});

	it("hands a channel over to a second device without telling the room anyone left", async () => {
		const laptop = connect("alice-token");
		const phone = connect("alice-token");
		const bob = connect("bob-token");
		await Promise.all([waitForOpen(laptop), waitForOpen(phone), waitForOpen(bob)]);

		send(bob, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(bob);
		send(bob, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(bob);

		send(laptop, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(laptop, "joined");
		send(laptop, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrameOfType(laptop, "transportOptions");

		announced.length = 0;

		send(phone, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });

		expect(await nextFrameOfType(laptop, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "superseded",
		});
		await nextFrameOfType(phone, "joined");

		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(true);
		expect(sfu.presenceOf(ALICE)).toBe(VOICE_CHANNEL);
		expect(announced.map((entry) => entry.frame.event)).not.toContain("leave");
		expect(
			(inboxes.get(bob)?.held ?? []).filter(
				(frame) => frame.$type === "social.colibri.beta.voice.defs#peerLeft",
			),
		).toEqual([]);

		laptop.close();
		phone.close();
		bob.close();
	});

	it("drops the old channel when a second device joins a different one", async () => {
		const laptop = connect("alice-token");
		const phone = connect("alice-token");
		await Promise.all([waitForOpen(laptop), waitForOpen(phone)]);

		send(laptop, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(laptop, "joined");
		send(laptop, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrameOfType(laptop, "transportOptions");

		announced.length = 0;

		send(phone, { $type: "social.colibri.beta.voice.defs#join", channel: OTHER_VOICE_CHANNEL });

		expect(await nextFrameOfType(laptop, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "superseded",
		});
		await nextFrameOfType(phone, "joined");

		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(false);
		expect(voiceServer.isJoined(OTHER_VOICE_CHANNEL, ALICE)).toBe(true);
		expect(announced).toContainEqual(
			expect.objectContaining({
				frame: expect.objectContaining({ event: "leave", channel: VOICE_CHANNEL, did: ALICE }),
			}),
		);

		laptop.close();
		phone.close();
	});

	it("tells a joiner who is already in the room", async () => {
		const bob = connect("bob-token");
		await waitForOpen(bob);
		send(bob, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(bob);
		send(bob, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(bob);

		await sfu.moderate(VOICE_CHANNEL, BOB, { muted: true });

		const alice = connect("alice-token");
		await waitForOpen(alice);
		send(alice, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });

		await nextFrameOfType(alice, "joined");
		expect(await nextFrameOfType(alice, "peerJoined")).toMatchObject({ did: BOB });
		expect(await nextFrameOfType(alice, "moderationChanged")).toMatchObject({
			did: BOB,
			muted: true,
			serverMuted: true,
		});

		alice.close();
		bob.close();
	});

	it("answers a frame the sfu cannot serve instead of crashing", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#setSelfState", muted: true });

		expect(await nextFrame(ws)).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
		});

		ws.close();
	});

	it("pauses a server-muted peer's audio whatever source it claims", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrame(ws);

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "screen",
		});
		const info = await nextFrameOfType(ws, "producerInfo");
		expect(info).toMatchObject({ paused: false });

		await sfu.moderate(VOICE_CHANNEL, ALICE, { muted: true });

		expect(await sfu.listProducers(VOICE_CHANNEL)).toContainEqual(
			expect.objectContaining({ producerId: info.producerId, paused: true }),
		);

		ws.close();
	});
});

describe("transportOptions", () => {
	const options = social.colibri.beta.voice.defs.transportOptions;
	const frame = (iceCandidates: unknown) => ({
		$type: "social.colibri.beta.voice.defs#transportOptions",
		id: "transport-1",
		iceParameters: { usernameFragment: "abc", password: "def" },
		iceCandidates,
		dtlsParameters: { fingerprints: [] },
		direction: "send",
	});

	it("accepts the array of candidates a WebRTC transport actually hands back", () => {
		const candidates = [
			{ foundation: "udpcandidate", ip: "203.0.113.1", port: 44444, protocol: "udp" },
			{ foundation: "tcpcandidate", ip: "203.0.113.1", port: 44444, protocol: "tcp" },
		];

		const result = options.safeParse(frame(candidates));
		expect(result.success).toBe(true);
		expect((result as { value: { iceCandidates: unknown } }).value.iceCandidates).toEqual(
			candidates,
		);
	});

	it("accepts a transport with no candidates gathered yet", () => {
		expect(options.safeParse(frame([])).success).toBe(true);
	});

	it("rejects a single candidate object, which is what the old lexicon asked for", () => {
		expect(options.safeParse(frame({ foundation: "udpcandidate" })).success).toBe(false);
	});
});
