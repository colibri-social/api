import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { type ActorAuthz, CommunityLoader } from "@colibri-social/community";
import { channelSpace, SPACE_TYPES, threadSpace } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "./actor.js";
import { ChannelViews } from "./channel.js";
import { ThreadViews } from "./thread.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const CHANNEL_SKEY = "3lkchanneltest0";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const THREAD_SKEY = "3lkthreadtest00";
const THREAD = threadSpace(COMMUNITY, THREAD_SKEY);
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let ctx: AppContext;
let threads: ThreadViews;

const authz = (): ActorAuthz =>
	({
		community: COMMUNITY,
		actor: AUTHOR,
		member: true,
		isOwner: true,
		isBanned: false,
		roles: [],
		overrides: [],
	}) as unknown as ActorAuthz;

const putMessage = async (rkey: string) => {
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "the message it started from",
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
	});
};

const putThread = async (anchorRkey?: string) => {
	await database.db.insert(database.tables.threads).values({
		space: THREAD,
		community: COMMUNITY,
		channel: SPACE,
		skey: THREAD_SKEY,
		name: "side conversation",
		createdBy: AUTHOR,
		createdAt: NOW,
		visibleToRoles: [],
		visibleToMembers: [],
		lastActivityAt: NOW,
		indexedAt: NOW,
		...(anchorRkey ? { anchorSpace: SPACE, anchorAuthor: AUTHOR, anchorRkey } : {}),
	});
};

beforeEach(async () => {
	database = await openTestDatabase();

	ctx = {
		database,
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
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
		log: { warn: () => {}, info: () => {} },
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

	await database.db.insert(database.tables.channels).values({
		space: SPACE,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: CHANNEL_SKEY,
		name: "general",
	});
});

afterEach(async () => {
	await database.destroy();
});

describe("ThreadViews anchor messages", () => {
	it("types the anchor message so the union it sits in accepts it", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread(rkey);

		const row = await threads.row(THREAD);
		const view = await threads.view(row!, authz(), AUTHOR, {
			anchorMessages: true,
		});

		expect(view?.anchorMessage?.$type).toBe("social.colibri.beta.channel.defs#messageView");
	});

	it("leaves the anchor message out when the message is gone", async () => {
		await putThread(nextTid());

		const row = await threads.row(THREAD);
		const view = await threads.view(row!, authz(), AUTHOR, {
			anchorMessages: true,
		});

		expect(view).not.toBeNull();
		expect(view?.anchorMessage).toBeUndefined();
	});

	it("leaves the anchor message out unless it is asked for", async () => {
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread(rkey);

		const row = await threads.row(THREAD);
		const view = await threads.view(row!, authz(), AUTHOR);

		expect(view?.anchorMessage).toBeUndefined();
	});
});
