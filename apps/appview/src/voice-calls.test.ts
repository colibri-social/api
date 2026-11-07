import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVoiceCalls } from "./voice-calls.js";

const CHANNEL = "ats://did:plc:community/social.colibri.beta.channel.voice/3lkvoice00000";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

const SILENT = {
	muted: false,
	deafened: false,
	serverMuted: false,
	serverDeafened: false,
	camera: false,
	screen: false,
};

let database: TestDatabase;

const registerNode = async (
	id: string,
	options: { region?: string; roles?: ("voice" | "api")[]; heartbeatAgoMs?: number } = {},
) => {
	const heartbeat = new Date(Date.now() - (options.heartbeatAgoMs ?? 0)).toISOString();

	await database.db.insert(database.tables.nodes).values({
		id,
		region: options.region ?? "eu",
		roles: options.roles ?? ["voice"],
		publicUrl: `https://${id}.nodes.colibri.social`,
		tailnetUrl: `http://${id}:3000`,
		state: "active",
		registeredAt: heartbeat,
		heartbeatAt: heartbeat,
	});
};

beforeEach(async () => {
	database = await openTestDatabase();
});

afterEach(async () => {
	await database.destroy();
});

describe("createVoiceCalls", () => {
	it("lists live voice nodes in this node's region first", async () => {
		await registerNode("us-1", { region: "us" });
		await registerNode("eu-2", { region: "eu" });
		await registerNode("eu-api", { region: "eu", roles: ["api"] });
		await registerNode("eu-stale", { region: "eu", heartbeatAgoMs: 5 * 60_000 });

		const calls = createVoiceCalls({ database, nodeId: "eu-1", region: "eu" });

		expect((await calls.candidates()).map((node) => node.id)).toEqual(["eu-2", "us-1"]);
	});

	it("hands a call over only while this node owns it", async () => {
		const a = createVoiceCalls({ database, nodeId: "node-a" });
		const b = createVoiceCalls({ database, nodeId: "node-b" });

		await a.claim(CHANNEL, { acceptNew: true });

		expect(await b.handOver(CHANNEL, "node-c")).toBe(false);
		expect(await a.handOver(CHANNEL, "node-b")).toBe(true);
		expect(await a.ownerOf(CHANNEL)).toBe("node-b");
	});

	it("keeps a participant row that moved to another node when the old node lets go", async () => {
		const a = createVoiceCalls({ database, nodeId: "node-a" });
		const b = createVoiceCalls({ database, nodeId: "node-b" });

		await a.joined(ALICE, CHANNEL, SILENT);
		await b.joined(ALICE, CHANNEL, { ...SILENT, muted: true });
		await a.left(ALICE, CHANNEL);

		expect(await a.participant(ALICE)).toMatchObject({ nodeId: "node-b", muted: true });
	});

	it("sweeps participants and calls of nodes that stopped reporting", async () => {
		await registerNode("node-b");
		await registerNode("node-dead", { heartbeatAgoMs: 5 * 60_000 });

		const main = createVoiceCalls({ database, nodeId: "node-a" });
		const live = createVoiceCalls({ database, nodeId: "node-b" });
		const dead = createVoiceCalls({ database, nodeId: "node-dead" });

		await live.joined(ALICE, CHANNEL, SILENT);
		await dead.joined(BOB, `${CHANNEL}x`, SILENT);
		await dead.claim(`${CHANNEL}x`, { acceptNew: true });

		const swept = await main.sweep();

		expect(swept.map((row) => row.did)).toEqual([BOB]);
		expect(await main.participant(BOB)).toBeNull();
		expect(await main.participant(ALICE)).not.toBeNull();
		expect(await main.ownerOf(`${CHANNEL}x`)).toBeNull();
	});

	it("forgets this node's calls and returns who was in them", async () => {
		const calls = createVoiceCalls({ database, nodeId: "node-a" });

		await calls.claim(CHANNEL, { acceptNew: true });
		await calls.joined(ALICE, CHANNEL, SILENT);

		const removed = await calls.forgetNode();

		expect(removed.map((row) => row.did)).toEqual([ALICE]);
		expect(await calls.ownerOf(CHANNEL)).toBeNull();
	});

	it("starts a call on a draining node when no other voice node is up", async () => {
		const calls = createVoiceCalls({ database, nodeId: "node-a" });

		await expect(calls.claim(CHANNEL, { acceptNew: false })).resolves.toEqual({ kind: "here" });
	});

	it("keeps server moderation per Space member until it is lifted", async () => {
		const calls = createVoiceCalls({ database, nodeId: "node-a" });
		const restarted = createVoiceCalls({ database, nodeId: "node-b" });

		await calls.saveModeration("did:plc:community", ALICE, {
			serverMuted: true,
			serverDeafened: true,
		});

		expect(await restarted.moderationOf("did:plc:community", ALICE)).toEqual({
			serverMuted: true,
			serverDeafened: true,
		});
		expect(await restarted.moderationOf("did:plc:other", ALICE)).toEqual({
			serverMuted: false,
			serverDeafened: false,
		});

		await restarted.saveModeration("did:plc:community", ALICE, {
			serverMuted: false,
			serverDeafened: false,
		});

		expect(await database.db.select().from(database.tables.voiceModeration)).toEqual([]);
	});
});
