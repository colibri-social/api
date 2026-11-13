import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	type ActorAuthz,
	anonymousAuthz,
	type ChannelState,
	type RoleState,
} from "@colibri-social/community";
import { COLLECTIONS, channelSpace, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { VoiceSfu, type WorkerPoolLike } from "@colibri-social/voice";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { asRouter, createFakeRouter } from "../../../../packages/voice/src/mock-mediasoup.js";
import { silentAnnouncer } from "../announce.js";
import { type AuthzChanges, createAuthzChanges } from "../authz-changes.js";
import type { AppContext } from "../context.js";
import { createDrainState } from "../drain.js";
import { noTurnCredentials } from "../turn.js";
import { createVoiceCalls } from "../voice-calls.js";
import { VoiceServer } from "./voice.js";

const VOICE_PATH = "/xrpc/social.colibri.beta.voice.subscribeSignals";

const COMMUNITY = "did:plc:community";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const MALLORY = "did:plc:mallory";

const VOICE_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "general");
const OTHER_VOICE_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "lounge");
const TEXT_CHANNEL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "chat");

const VOICE_PERMISSIONS = [
	"voice.speak",
	"voice.listen",
	"voice.camera",
	"voice.screenshare",
	"voice.chat",
];

const membersRole = (
	permissions: string[] = VOICE_PERMISSIONS,
	channelOverrides: RoleState["channelOverrides"] = [],
): RoleState => ({
	rkey: "members",
	name: "Members",
	permissions,
	position: 0,
	hoisted: false,
	mentionable: false,
	protected: false,
	isDefault: true,
	channelOverrides,
});

const memberAuthz = (did: string, role: RoleState = membersRole()): ActorAuthz => ({
	actor: did,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: { did, roles: [role.rkey], joinedAt: "2026-01-01T00:00:00.000Z", nickname: null },
	roles: [role],
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

const fakeRouters: ReturnType<typeof createFakeRouter>[] = [];

const fakeWorkerPool = (): WorkerPoolLike => ({
	createRouter: async () => {
		const router = createFakeRouter();
		fakeRouters.push(router);
		return { router: asRouter(router) };
	},
	close: async () => {},
});

type Harness = {
	ctx: AppContext;
	authzChanges: AuthzChanges;
	channels: Map<string, ChannelState>;
	authz: Map<string, ActorAuthz>;
};

const buildCtx = (voice: VoiceSfu | null, database?: TestDatabase): Harness => {
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
		nodeId: "node-a",
		config: { NODE_REGION: "eu", VOICE_MIGRATION_NOTICE_SECONDS: 60 },
		drain: createDrainState(),
		turn: noTurnCredentials,
		...(database
			? { database, voiceCalls: createVoiceCalls({ database, nodeId: "node-a", region: "eu" }) }
			: {}),
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
			categoryAudience: async () => null,
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
	let database: TestDatabase;
	let announced: Array<{ community: string; frame: Record<string, unknown> }>;

	beforeEach(async () => {
		database = await openTestDatabase();
		sfu = await VoiceSfu.create({ roomGraceMs: 1_000 }, { workerPool: fakeWorkerPool() });
		announced = [];
		harness = buildCtx(sfu, database);
		harness.ctx.announce = {
			...silentAnnouncer,
			toCommunity: (community, frame) => {
				announced.push({ community, frame });
			},
		};
		voiceServer = new VoiceServer(harness.ctx);
		http = createServer();
		voiceServer.attach(http);
		port = await listen(http);
	});

	afterEach(async () => {
		await voiceServer.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await sfu.close();
		await database.destroy();
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
			nodeId: "node-a",
			region: "eu",
			permissions: VOICE_PERMISSIONS,
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
		const transport = await nextFrameOfType(aliceWs, "transportOptions");

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

	it("announces camera and screen sharing to the community, and keeps it across a mute", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const transport = await nextFrameOfType(ws, "transportOptions");

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "audio",
			rtpParameters: {},
			source: "microphone",
		});
		await nextFrameOfType(ws, "producerInfo");
		expect(announced.map((entry) => entry.frame.event)).toEqual(["join"]);

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "video",
			rtpParameters: {},
			source: "camera",
		});
		const camera = await nextFrameOfType(ws, "producerInfo");
		expect(announced.at(-1)?.frame).toMatchObject({
			event: "update",
			did: ALICE,
			voice: { camera: true },
		});

		send(ws, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: transport.id,
			kind: "video",
			rtpParameters: {},
			source: "screen",
		});
		await nextFrameOfType(ws, "producerInfo");
		expect(announced.at(-1)?.frame).toMatchObject({ voice: { camera: true, screen: true } });

		await sfu.moderate(VOICE_CHANNEL, ALICE, { muted: true });
		expect(announced.at(-1)?.frame).toMatchObject({
			voice: { muted: true, camera: true, screen: true },
		});

		send(ws, {
			$type: "social.colibri.beta.voice.defs#closeProducer",
			producerId: camera.producerId,
		});
		await vi.waitFor(() => {
			const voice = announced.at(-1)?.frame.voice as Record<string, unknown>;
			expect(voice.screen).toBe(true);
			expect(voice).not.toHaveProperty("camera");
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

	describe("voice permissions", () => {
		const HIDDEN = { ...openChannel(VOICE_CHANNEL, "general"), visibleToRoles: ["staff"] };

		const join = async (ws: WebSocket, channel = VOICE_CHANNEL): Promise<Frame> => {
			send(ws, { $type: "social.colibri.beta.voice.defs#join", channel });

			return nextFrameOfType(ws, "joined");
		};

		const sendTransport = async (ws: WebSocket): Promise<string> => {
			send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });

			return (await nextFrameOfType(ws, "transportOptions")).id as string;
		};

		const produce = async (
			ws: WebSocket,
			transportId: string,
			kind: string,
			source: string,
		): Promise<Frame> => {
			send(ws, {
				$type: "social.colibri.beta.voice.defs#produce",
				transportId,
				kind,
				rtpParameters: {},
				source,
			});

			for (;;) {
				const frame = await nextFrame(ws);

				if (frame.$type === "social.colibri.beta.voice.defs#error") return frame;
				if (frame.$type === "social.colibri.beta.voice.defs#producerInfo") return frame;
			}
		};

		const restrict = (did: string, deny: string[]) => {
			harness.authz.set(
				did,
				memberAuthz(did, membersRole(VOICE_PERMISSIONS, [{ channel: "general", allow: [], deny }])),
			);
		};

		it("hands the joiner the voice permissions it holds in the channel", async () => {
			restrict(ALICE, ["voice.camera", "voice.chat"]);

			const ws = connect("alice-token");
			await waitForOpen(ws);

			expect((await join(ws)).permissions).toEqual([
				"voice.speak",
				"voice.listen",
				"voice.screenshare",
			]);
			ws.close();
		});

		it("force-mutes and force-deafens a member without speak and listen", async () => {
			restrict(ALICE, ["voice.speak", "voice.listen"]);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			expect(sfu.getVoiceState(VOICE_CHANNEL, ALICE)).toEqual({
				muted: true,
				deafened: true,
				serverMuted: true,
				serverDeafened: true,
			});
			ws.close();
		});

		it("keeps a permission mute when a moderator unmutes, and saves no moderation", async () => {
			restrict(ALICE, ["voice.speak"]);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			await voiceServer.apply({ channel: VOICE_CHANNEL, subject: ALICE, muted: true });
			await voiceServer.apply({ channel: VOICE_CHANNEL, subject: ALICE, muted: false });

			expect(sfu.getVoiceState(VOICE_CHANNEL, ALICE)).toMatchObject({
				muted: true,
				serverMuted: true,
			});
			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.moderationOf(COMMUNITY, ALICE)).toEqual({
					serverMuted: false,
					serverDeafened: false,
				});
			});
			ws.close();
		});

		it("refuses the producers a missing permission covers and allows the rest", async () => {
			restrict(ALICE, ["voice.speak", "voice.camera", "voice.screenshare"]);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);
			const transportId = await sendTransport(ws);

			expect(await produce(ws, transportId, "audio", "microphone")).toMatchObject({
				error: "Forbidden",
				message: "you lack the voice.speak permission in this channel",
			});
			expect(await produce(ws, transportId, "video", "camera")).toMatchObject({
				error: "Forbidden",
				message: "you lack the voice.camera permission in this channel",
			});
			expect(await produce(ws, transportId, "video", "screen")).toMatchObject({
				error: "Forbidden",
				message: "you lack the voice.screenshare permission in this channel",
			});
			expect(await produce(ws, transportId, "audio", "screen")).toMatchObject({
				error: "Forbidden",
			});
			ws.close();
		});

		it("updates restrictions and closes producers when permissions change mid-call", async () => {
			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);
			const transportId = await sendTransport(ws);
			const mic = await produce(ws, transportId, "audio", "microphone");
			const camera = await produce(ws, transportId, "video", "camera");

			expect(mic.$type).toBe("social.colibri.beta.voice.defs#producerInfo");
			expect(camera.$type).toBe("social.colibri.beta.voice.defs#producerInfo");

			restrict(ALICE, ["voice.speak", "voice.camera", "voice.chat"]);
			await voiceServer.revalidate(COMMUNITY);

			expect(await nextFrameOfType(ws, "permissionsChanged")).toEqual({
				$type: "social.colibri.beta.voice.defs#permissionsChanged",
				channel: VOICE_CHANNEL,
				permissions: ["voice.listen", "voice.screenshare"],
			});
			expect(sfu.getVoiceState(VOICE_CHANNEL, ALICE)).toMatchObject({ serverMuted: true });
			expect(
				(await sfu.listProducers(VOICE_CHANNEL)).filter((producer) => producer.did === ALICE),
			).toEqual([]);

			restrict(ALICE, []);
			await voiceServer.revalidate(COMMUNITY);

			expect((await nextFrameOfType(ws, "permissionsChanged")).permissions).toEqual(
				VOICE_PERMISSIONS,
			);
			expect(sfu.getVoiceState(VOICE_CHANNEL, ALICE)).toMatchObject({ serverMuted: false });
			ws.close();
		});

		it("sends nothing when an authz change leaves the permissions as they were", async () => {
			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			await voiceServer.revalidate(COMMUNITY);

			expect(
				(inboxes.get(ws)?.held ?? []).filter(
					(frame) => frame.$type === "social.colibri.beta.voice.defs#permissionsChanged",
				),
			).toEqual([]);
			ws.close();
		});

		it("lets a moved member join a channel they can't see, without its chat", async () => {
			harness.channels.set(VOICE_CHANNEL, HIDDEN);
			await harness.ctx.voiceCalls.grantMove(ALICE, VOICE_CHANNEL, BOB);

			const ws = connect("alice-token");
			await waitForOpen(ws);

			expect((await join(ws)).permissions).toEqual([
				"voice.speak",
				"voice.listen",
				"voice.camera",
				"voice.screenshare",
			]);

			await voiceServer.revalidate(COMMUNITY);

			expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(true);
			ws.close();
		});

		it("refuses a channel the member can't see without a grant", async () => {
			harness.channels.set(VOICE_CHANNEL, HIDDEN);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });

			expect(await nextFrameOfType(ws, "error")).toMatchObject({ error: "Forbidden" });
			ws.close();
		});

		it("ends the grant when the moved member leaves, so they can't rejoin", async () => {
			harness.channels.set(VOICE_CHANNEL, HIDDEN);
			await harness.ctx.voiceCalls.grantMove(ALICE, VOICE_CHANNEL, BOB);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			send(ws, { $type: "social.colibri.beta.voice.defs#leave" });

			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.hasMoveGrant(ALICE, VOICE_CHANNEL)).toBe(false);
			});

			send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });

			expect(await nextFrameOfType(ws, "error")).toMatchObject({ error: "Forbidden" });
			ws.close();
		});

		it("ends the grant when the moved member's connection drops", async () => {
			harness.channels.set(VOICE_CHANNEL, HIDDEN);
			await harness.ctx.voiceCalls.grantMove(ALICE, VOICE_CHANNEL, BOB);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);
			ws.close();

			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.hasMoveGrant(ALICE, VOICE_CHANNEL)).toBe(false);
			});
		});

		it("ends every other grant when the member joins a channel", async () => {
			await harness.ctx.voiceCalls.grantMove(ALICE, OTHER_VOICE_CHANNEL, BOB);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			expect(await harness.ctx.voiceCalls.hasMoveGrant(ALICE, OTHER_VOICE_CHANNEL)).toBe(false);
			ws.close();
		});

		it("hands a moved member the destination's channel view", async () => {
			await database.db.insert(database.tables.channels).values({
				space: OTHER_VOICE_CHANNEL,
				community: COMMUNITY,
				spaceType: SPACE_TYPES.channelVoice,
				skey: "lounge",
				name: "Lounge",
				category: "3lkcategory",
				visibleToRoles: ["staff"],
			});

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await join(ws);

			await voiceServer.move(VOICE_CHANNEL, ALICE, OTHER_VOICE_CHANNEL);

			const moved = await nextFrameOfType(ws, "moved");

			expect(moved).toMatchObject({
				channel: OTHER_VOICE_CHANNEL,
				view: {
					space: OTHER_VOICE_CHANNEL,
					type: SPACE_TYPES.channelVoice,
					name: "Lounge",
					category: "3lkcategory",
					private: true,
					viewer: { canRead: false, canPost: false },
				},
			});
			expect(social.colibri.beta.voice.defs.moved.safeParse(moved).success).toBe(true);
			ws.close();
		});

		describe("placing the destination", () => {
			const FIRST = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "first");
			const SECRET = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "secret");
			const LAST = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "last");

			const putChannel = (
				space: string,
				skey: string,
				options: { category?: string; position?: number; visibleToRoles?: string[] } = {},
			) =>
				database.db.insert(database.tables.channels).values({
					space,
					community: COMMUNITY,
					spaceType: space.includes("voice") ? SPACE_TYPES.channelVoice : SPACE_TYPES.channelText,
					skey,
					name: skey,
					category: options.category ?? null,
					position: options.position ?? 0,
					visibleToRoles: options.visibleToRoles ?? [],
				});

			const movedFrame = async (): Promise<Frame> => {
				const ws = connect("alice-token");
				await waitForOpen(ws);
				await join(ws);

				await voiceServer.move(VOICE_CHANNEL, ALICE, OTHER_VOICE_CHANNEL);

				const frame = await nextFrameOfType(ws, "moved");

				expect(social.colibri.beta.voice.defs.moved.safeParse(frame).success).toBe(true);
				ws.close();

				return frame;
			};

			it("names the nearest readable channel before it in the category's order", async () => {
				await database.db.insert(database.tables.categories).values({
					community: COMMUNITY,
					rkey: "3lkcategory",
					name: "Voice",
					channelOrder: ["first", "secret", "lounge", "last"],
				});
				await putChannel(FIRST, "first", { category: "3lkcategory" });
				await putChannel(SECRET, "secret", {
					category: "3lkcategory",
					visibleToRoles: ["staff"],
				});
				await putChannel(OTHER_VOICE_CHANNEL, "lounge", {
					category: "3lkcategory",
					visibleToRoles: ["staff"],
				});
				await putChannel(LAST, "last", { category: "3lkcategory" });

				expect((await movedFrame()).after).toBe(FIRST);
			});

			it("leaves after out when no readable channel comes before it", async () => {
				await database.db.insert(database.tables.categories).values({
					community: COMMUNITY,
					rkey: "3lkcategory",
					name: "Voice",
					channelOrder: ["secret", "lounge", "first"],
				});
				await putChannel(SECRET, "secret", {
					category: "3lkcategory",
					visibleToRoles: ["staff"],
				});
				await putChannel(OTHER_VOICE_CHANNEL, "lounge", { category: "3lkcategory" });
				await putChannel(FIRST, "first", { category: "3lkcategory" });

				const frame = await movedFrame();

				expect(frame.view).toMatchObject({ space: OTHER_VOICE_CHANNEL });
				expect(frame).not.toHaveProperty("after");
			});

			it("follows channel positions for a channel outside any category", async () => {
				await putChannel(FIRST, "first", { position: 0 });
				await putChannel(LAST, "last", { position: 1 });
				await putChannel(OTHER_VOICE_CHANNEL, "lounge", {
					position: 2,
					visibleToRoles: ["staff"],
				});
				await putChannel(SECRET, "secret", { category: "3lkcategory", position: 1 });

				expect((await movedFrame()).after).toBe(LAST);
			});
		});

		it("keeps a grant through a move's leave of the old channel", async () => {
			await harness.ctx.voiceCalls.grantMove(ALICE, OTHER_VOICE_CHANNEL, BOB);

			const ws = connect("alice-token");
			await waitForOpen(ws);
			await harness.ctx.voiceCalls.revokeMoveGrant(ALICE, VOICE_CHANNEL);
			send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
			await nextFrameOfType(ws, "joined");
			await harness.ctx.voiceCalls.grantMove(ALICE, OTHER_VOICE_CHANNEL, BOB);

			await voiceServer.move(VOICE_CHANNEL, ALICE, OTHER_VOICE_CHANNEL);
			await nextFrameOfType(ws, "moved");

			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.participant(ALICE)).toBeNull();
			});
			expect(await harness.ctx.voiceCalls.hasMoveGrant(ALICE, OTHER_VOICE_CHANNEL)).toBe(true);
			ws.close();
		});
	});

	it("tells the room and the community about a peer that has not created a transport", async () => {
		const bobWs = connect("bob-token");
		await waitForOpen(bobWs);

		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(bobWs, "joined");

		announced.length = 0;
		const bobSeesAlice = nextFrameOfType(bobWs, "peerJoined");

		const aliceWs = connect("alice-token");
		await waitForOpen(aliceWs);
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(aliceWs, "joined");

		expect(await bobSeesAlice).toMatchObject({
			$type: "social.colibri.beta.voice.defs#peerJoined",
			did: ALICE,
		});

		expect(announced).toContainEqual({
			community: COMMUNITY,
			frame: expect.objectContaining({
				$type: "social.colibri.beta.sync.defs#voiceEvent",
				event: "join",
				did: ALICE,
				channel: VOICE_CHANNEL,
			}),
		});

		aliceWs.close();
		bobWs.close();
	});

	it("hands a joining peer the roster of peers without transports", async () => {
		const bobWs = connect("bob-token");
		await waitForOpen(bobWs);
		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(bobWs, "joined");

		const aliceWs = connect("alice-token");
		await waitForOpen(aliceWs);
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(aliceWs, "joined");

		expect(await nextFrameOfType(aliceWs, "peerJoined")).toMatchObject({
			$type: "social.colibri.beta.voice.defs#peerJoined",
			did: BOB,
		});

		aliceWs.close();
		bobWs.close();
	});

	it("disconnects a peer that joined but never created a transport", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);

		expect(sfu.presenceOf(ALICE)).toBe(VOICE_CHANNEL);
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(true);

		await voiceServer.disconnect(VOICE_CHANNEL, ALICE);

		expect(await nextFrameOfType(ws, "disconnected")).toEqual({
			$type: "social.colibri.beta.voice.defs#disconnected",
			reason: "moderator",
		});
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(false);

		ws.close();
	});

	it("tells a moved peer where to go and removes it from the old channel", async () => {
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(aliceWs, "joined");
		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(bobWs, "joined");

		await voiceServer.move(VOICE_CHANNEL, ALICE, OTHER_VOICE_CHANNEL);

		expect(await nextFrameOfType(aliceWs, "moved")).toEqual({
			$type: "social.colibri.beta.voice.defs#moved",
			channel: OTHER_VOICE_CHANNEL,
		});
		expect(await nextFrameOfType(bobWs, "peerLeft")).toMatchObject({ did: ALICE });
		expect(voiceServer.isJoined(VOICE_CHANNEL, ALICE)).toBe(false);
		expect(sfu.presenceOf(ALICE)).toBeUndefined();

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: OTHER_VOICE_CHANNEL });
		expect(await nextFrameOfType(aliceWs, "joined")).toMatchObject({
			channel: OTHER_VOICE_CHANNEL,
		});
		expect(sfu.presenceOf(ALICE)).toBe(OTHER_VOICE_CHANNEL);

		aliceWs.close();
		bobWs.close();
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

	it("broadcasts a client-reported speaking change and announces it to the community", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		await nextFrame(ws);
		send(ws, { $type: "social.colibri.beta.voice.defs#setSpeaking", speaking: true });

		expect(await nextFrameOfType(ws, "speakingUpdate")).toMatchObject({
			did: ALICE,
			speaking: true,
		});
		expect(announced.at(-1)).toEqual({
			community: COMMUNITY,
			frame: {
				$type: "social.colibri.beta.sync.defs#voiceEvent",
				event: "speaking",
				channel: VOICE_CHANNEL,
				did: ALICE,
				speaking: true,
			},
		});

		ws.close();
	});

	it("answers a frame the sfu cannot serve instead of crashing", async () => {
		const ws = connect("alice-token");
		await waitForOpen(ws);

		send(ws, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrame(ws);
		await sfu.leave(VOICE_CHANNEL, ALICE);
		send(ws, { $type: "social.colibri.beta.voice.defs#setSelfState", muted: true });

		expect(await nextFrameOfType(ws, "error")).toMatchObject({
			$type: "social.colibri.beta.voice.defs#error",
		});

		ws.close();
	});

	it("tells a screen sharer once that a viewer cannot decode its codec", async () => {
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(aliceWs, "joined");
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const sendTransport = await nextFrameOfType(aliceWs, "transportOptions");
		send(aliceWs, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: sendTransport.id,
			kind: "video",
			rtpParameters: {},
			source: "screen",
		});
		const screen = await nextFrameOfType(aliceWs, "producerInfo");

		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(bobWs, "joined");
		send(bobWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "recv" });
		const recvTransport = await nextFrameOfType(bobWs, "transportOptions");

		fakeRouters.at(-1)?.canConsume.mockReturnValue(false);
		const consume = {
			$type: "social.colibri.beta.voice.defs#consume",
			transportId: recvTransport.id,
			producerId: screen.producerId,
			rtpCapabilities: {},
		};

		send(bobWs, consume);
		expect(await nextFrameOfType(bobWs, "error")).toMatchObject({ error: "NotFound" });
		send(bobWs, consume);
		expect(await nextFrameOfType(bobWs, "error")).toMatchObject({ error: "NotFound" });

		expect(await nextFrameOfType(aliceWs, "codecUnsupported")).toEqual({
			$type: "social.colibri.beta.voice.defs#codecUnsupported",
			producerId: screen.producerId,
		});
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#heartbeat" });
		await nextFrameOfType(aliceWs, "ack");
		expect(
			(inboxes.get(aliceWs)?.held ?? []).filter(
				(frame) => frame.$type === "social.colibri.beta.voice.defs#codecUnsupported",
			),
		).toEqual([]);
		expect(
			(inboxes.get(bobWs)?.held ?? []).filter(
				(frame) => frame.$type === "social.colibri.beta.voice.defs#codecUnsupported",
			),
		).toEqual([]);

		aliceWs.close();
		bobWs.close();
	});

	it("applies a viewer's consumer preference and refuses one from anyone else", async () => {
		const aliceWs = connect("alice-token");
		const bobWs = connect("bob-token");
		await Promise.all([waitForOpen(aliceWs), waitForOpen(bobWs)]);

		send(aliceWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(aliceWs, "joined");
		send(aliceWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "send" });
		const sendTransport = await nextFrameOfType(aliceWs, "transportOptions");
		send(aliceWs, {
			$type: "social.colibri.beta.voice.defs#produce",
			transportId: sendTransport.id,
			kind: "video",
			rtpParameters: {},
			source: "camera",
		});
		const camera = await nextFrameOfType(aliceWs, "producerInfo");

		send(bobWs, { $type: "social.colibri.beta.voice.defs#join", channel: VOICE_CHANNEL });
		await nextFrameOfType(bobWs, "joined");
		send(bobWs, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "recv" });
		const recvTransport = await nextFrameOfType(bobWs, "transportOptions");
		send(bobWs, {
			$type: "social.colibri.beta.voice.defs#consume",
			transportId: recvTransport.id,
			producerId: camera.producerId,
			rtpCapabilities: {},
		});
		const consumerOptions = await nextFrameOfType(bobWs, "consumerOptions");

		const router = fakeRouters.at(-1);
		const rawRecv = await router?.createWebRtcTransport.mock.results[1]?.value;
		const rawConsumer = await rawRecv?.consume.mock.results[0]?.value;
		expect(rawConsumer?.id).toBe(consumerOptions.id);

		send(bobWs, {
			$type: "social.colibri.beta.voice.defs#setConsumerPreference",
			consumerId: consumerOptions.id,
			spatialLayer: 1,
			temporalLayer: 0,
			paused: false,
		});
		expect(await nextFrame(bobWs)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });
		expect(rawConsumer?.setPreferredLayers).toHaveBeenCalledWith({
			spatialLayer: 1,
			temporalLayer: 0,
		});
		expect(rawConsumer?.paused).toBe(false);

		send(bobWs, {
			$type: "social.colibri.beta.voice.defs#setConsumerPreference",
			consumerId: consumerOptions.id,
			spatialLayer: 0,
			paused: true,
		});
		expect(await nextFrame(bobWs)).toEqual({ $type: "social.colibri.beta.voice.defs#ack" });
		expect(rawConsumer?.paused).toBe(true);

		send(aliceWs, {
			$type: "social.colibri.beta.voice.defs#setConsumerPreference",
			consumerId: consumerOptions.id,
			spatialLayer: 2,
			paused: false,
		});
		expect(await nextFrameOfType(aliceWs, "error")).toMatchObject({ error: "NotFound" });
		expect(rawConsumer?.paused).toBe(true);

		send(bobWs, {
			$type: "social.colibri.beta.voice.defs#setConsumerPreference",
			consumerId: consumerOptions.id,
			spatialLayer: 0,
		});
		expect(await nextFrame(bobWs)).toMatchObject({ error: "InvalidFrame" });

		aliceWs.close();
		bobWs.close();
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

	describe("across nodes", () => {
		const registerNode = async (id: string, state: "active" | "draining" = "active") => {
			const now = new Date().toISOString();

			await database.db.insert(database.tables.nodes).values({
				id,
				region: "eu",
				roles: ["voice"],
				publicUrl: `https://${id}.nodes.colibri.social`,
				tailnetUrl: `http://${id}:3000`,
				state,
				registeredAt: now,
				heartbeatAt: now,
			});
		};

		const pinCall = async (channel: string, nodeId: string) => {
			await database.db.insert(database.tables.voiceCalls).values({
				channel,
				nodeId,
				startedAt: new Date().toISOString(),
			});
		};

		const join = async (token: string, channel = VOICE_CHANNEL) => {
			const ws = connect(token);

			await waitForOpen(ws);
			send(ws, { $type: "social.colibri.beta.voice.defs#join", channel });

			return ws;
		};

		const callRow = async (channel = VOICE_CHANNEL) => {
			const [row] = await database.db
				.select()
				.from(database.tables.voiceCalls)
				.where(eq(database.tables.voiceCalls.channel, channel));

			return row;
		};

		it("pins a new call to this node and records who is in it", async () => {
			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");

			expect(await callRow()).toMatchObject({ nodeId: "node-a" });
			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.participant(ALICE)).toMatchObject({
					channel: VOICE_CHANNEL,
					nodeId: "node-a",
					muted: false,
				});
			});

			ws.close();
		});

		it("sends a joiner to the node already hosting the call", async () => {
			await registerNode("node-b");
			await pinCall(VOICE_CHANNEL, "node-b");

			const ws = await join("alice-token");

			expect(await nextFrame(ws)).toEqual({
				$type: "social.colibri.beta.voice.defs#callElsewhere",
				nodeId: "node-b",
				signalingUrl: "https://node-b.nodes.colibri.social",
				channel: VOICE_CHANNEL,
			});
			expect(sfu.listParticipants(VOICE_CHANNEL)).toEqual([]);

			ws.close();
		});

		it("takes over a call from a node that went away", async () => {
			await pinCall(VOICE_CHANNEL, "node-gone");

			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");

			expect(await callRow()).toMatchObject({ nodeId: "node-a" });

			ws.close();
		});

		it("keeps a server mute for the whole Space, in later calls and other channels", async () => {
			const first = await join("alice-token");

			await nextFrameOfType(first, "joined");
			await voiceServer.apply({ channel: VOICE_CHANNEL, subject: ALICE, muted: true });

			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.moderationOf(COMMUNITY, ALICE)).toEqual({
					serverMuted: true,
					serverDeafened: false,
				});
			});

			first.close();
			await vi.waitFor(() => expect(sfu.listParticipants(VOICE_CHANNEL)).toEqual([]));

			const second = await join("alice-token", OTHER_VOICE_CHANNEL);

			await nextFrameOfType(second, "joined");

			expect(sfu.getVoiceState(OTHER_VOICE_CHANNEL, ALICE)).toMatchObject({
				muted: true,
				serverMuted: true,
			});

			await voiceServer.apply({ channel: OTHER_VOICE_CHANNEL, subject: ALICE, muted: false });

			await vi.waitFor(async () => {
				expect(await harness.ctx.voiceCalls.moderationOf(COMMUNITY, ALICE)).toEqual({
					serverMuted: false,
					serverDeafened: false,
				});
			});

			second.close();
		});

		it("sends new calls on a draining node to another voice node", async () => {
			await registerNode("node-b");
			harness.ctx.drain.begin(new Date(Date.now() + 60_000));

			const ws = await join("alice-token");

			expect(await nextFrame(ws)).toMatchObject({
				$type: "social.colibri.beta.voice.defs#callElsewhere",
				nodeId: "node-b",
			});

			ws.close();
		});

		it("supersedes the caller's session on another node", async () => {
			const commands: unknown[] = [];

			harness.ctx.announce = {
				...harness.ctx.announce,
				voiceCommand: (node, command) => commands.push({ node, command }),
			};
			await database.db.insert(database.tables.voiceParticipants).values({
				did: ALICE,
				channel: OTHER_VOICE_CHANNEL,
				nodeId: "node-b",
				updatedAt: new Date().toISOString(),
			});

			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");

			expect(commands).toEqual([
				{
					node: "node-b",
					command: { channel: OTHER_VOICE_CHANNEL, subject: ALICE, supersede: true },
				},
			]);

			ws.close();
		});

		it("hands out TURN credentials next to the configured servers", async () => {
			harness.ctx.turn = {
				iceServers: async () => [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u" }],
			};

			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");
			send(ws, { $type: "social.colibri.beta.voice.defs#createTransport", direction: "recv" });

			expect(await nextFrameOfType(ws, "transportOptions")).toMatchObject({
				iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u" }],
			});

			ws.close();
		});

		it("moves a call to the node every participant reaches best", async () => {
			await registerNode("node-b");
			await registerNode("node-c");

			const alice = await join("alice-token");
			const bob = await join("bob-token");

			await nextFrameOfType(alice, "joined");
			await nextFrameOfType(bob, "joined");
			await voiceServer.beginMigration(new Date(Date.now() + 60 * 60_000));

			const proposal = await nextFrameOfType(alice, "migrationProposal");

			expect(proposal.candidates).toHaveLength(2);
			await nextFrameOfType(bob, "migrationProposal");

			send(alice, {
				$type: "social.colibri.beta.voice.defs#rttReport",
				results: [
					{ nodeId: "node-b", rttMs: 20 },
					{ nodeId: "node-c", rttMs: 40 },
				],
			});
			send(bob, {
				$type: "social.colibri.beta.voice.defs#rttReport",
				results: [
					{ nodeId: "node-b", rttMs: 90 },
					{ nodeId: "node-c", rttMs: 30 },
				],
			});
			await nextFrameOfType(alice, "ack");
			await nextFrameOfType(bob, "ack");
			send(bob, { $type: "social.colibri.beta.voice.defs#moveNow" });

			const expected = {
				$type: "social.colibri.beta.voice.defs#migrateTo",
				nodeId: "node-c",
				signalingUrl: "https://node-c.nodes.colibri.social",
				channel: VOICE_CHANNEL,
				now: true,
			};

			expect(await nextFrameOfType(alice, "migrateTo")).toEqual(expected);
			expect(await nextFrameOfType(bob, "migrateTo")).toEqual(expected);
			expect(await callRow()).toMatchObject({ nodeId: "node-c" });

			await database.db
				.update(database.tables.voiceParticipants)
				.set({ nodeId: "node-c" })
				.where(eq(database.tables.voiceParticipants.did, ALICE));
			announced = [];
			alice.close();

			await vi.waitFor(() => expect(sfu.listParticipants(VOICE_CHANNEL)).toEqual([BOB]));
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(announced.map(({ frame }) => frame.event)).not.toContain("leave");

			bob.close();

			await vi.waitFor(() =>
				expect(announced.map(({ frame }) => [frame.event, frame.did])).toContainEqual([
					"leave",
					BOB,
				]),
			);
		});

		it("proposes nothing without another voice node", async () => {
			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");
			await voiceServer.beginMigration(new Date(Date.now() + 60_000));
			send(ws, { $type: "social.colibri.beta.voice.defs#moveNow" });

			expect(await nextFrameOfType(ws, "error")).toMatchObject({ error: "NoMigration" });

			ws.close();
		});

		it("tells callers the node closed when it shuts down", async () => {
			const ws = await join("alice-token");

			await nextFrameOfType(ws, "joined");
			await voiceServer.close();

			expect(await nextFrameOfType(ws, "disconnected")).toEqual({
				$type: "social.colibri.beta.voice.defs#disconnected",
				reason: "nodeClosed",
			});
		});
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
