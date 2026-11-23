import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { channelSpace, SPACE_TYPES, threadSpace } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { ThreadViews } from "../views/thread.js";
import { handleGetThread, handleListThreads } from "./thread.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const BRIDGE = "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxxxxxx";
const GENERAL = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannelgen0");
const RANDOM = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannelran0");
const PUBLIC = threadSpace(COMMUNITY, "3lkthreadpub00");
const SECRET = threadSpace(COMMUNITY, "3lkthreadsec00");
const ELSEWHERE = threadSpace(COMMUNITY, "3lkthreadels00");
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let threads: ThreadViews;
let ctx: AppContext;

const bridgeReadable = new Set([GENERAL, PUBLIC]);

const putThread = async (space: string, channel: string, visibleToMembers: string[] = []) => {
	await database.db.insert(database.tables.threads).values({
		space,
		community: COMMUNITY,
		channel,
		skey: space.split("/").at(-1) ?? "",
		name: space,
		createdBy: AUTHOR,
		createdAt: NOW,
		visibleToRoles: [],
		visibleToMembers,
		lastActivityAt: NOW,
		indexedAt: NOW,
	});
};

const list = (viewer: string, channel?: string) => {
	return handleListThreads(
		ctx,
		threads,
		{ community: COMMUNITY, limit: 50, filter: "all", ...(channel ? { channel } : {}) },
		viewer,
	);
};

beforeEach(async () => {
	database = await openTestDatabase();

	ctx = {
		database,
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		bridges: {
			mayRead: async (did: string, space: string) => did === BRIDGE && bridgeReadable.has(space),
		},
		linkEmbeds: {
			peek: () => undefined,
			resolve: async () => new Map(),
			settle: async () => {},
		},
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandles: async () => {
				throw new Error("no identity in tests");
			},
		},
		log: { warn: () => {}, info: () => {}, debug: () => {} },
	} as unknown as AppContext;

	threads = new ThreadViews(ctx, new ChannelViews(ctx, new ActorViews(ctx)));

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test Community",
		labelers: [],
		profileSpace: "at://community/profile",
		configSpace: "at://community/configuration",
		membersSpace: "at://community/members",
		moderationSpace: "at://community/moderation",
		indexedAt: NOW,
	});

	for (const [space, skey] of [
		[GENERAL, "3lkchannelgen0"],
		[RANDOM, "3lkchannelran0"],
	] as const) {
		await database.db.insert(database.tables.channels).values({
			space,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey,
			name: skey,
		});
	}

	await putThread(PUBLIC, GENERAL);
	await putThread(SECRET, GENERAL, [AUTHOR]);
	await putThread(ELSEWHERE, RANDOM);
});

afterEach(async () => {
	await database.destroy();
});

describe("bridge thread reads", () => {
	it("lists the threads a bridge may read in an open channel", async () => {
		const { threads: listed } = await list(BRIDGE, GENERAL);

		expect(listed.map((thread) => thread.space)).toEqual([PUBLIC]);
		expect(listed[0]?.viewer.canRead).toBe(true);
		expect(listed[0]?.viewer.canPost).toBe(false);
	});

	it("refuses a bridge listing without a channel or in a channel it may not read", async () => {
		await expect(list(BRIDGE)).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(list(BRIDGE, RANDOM)).rejects.toMatchObject({ customErrorName: "Forbidden" });
		await expect(list(OUTSIDER, GENERAL)).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});

	it("gets a thread a bridge may read and refuses the rest", async () => {
		const { thread } = await handleGetThread(ctx, threads, PUBLIC, BRIDGE);

		expect(thread.space).toBe(PUBLIC);

		for (const space of [SECRET, ELSEWHERE]) {
			await expect(handleGetThread(ctx, threads, space, BRIDGE)).rejects.toMatchObject({
				customErrorName: "Forbidden",
			});
		}
		await expect(handleGetThread(ctx, threads, PUBLIC, OUTSIDER)).rejects.toMatchObject({
			customErrorName: "Forbidden",
		});
	});
});
