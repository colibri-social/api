import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { type ActorAuthz, CommunityLoader } from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	SPACE_TYPES,
	social,
	threadSpace,
} from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { eq } from "drizzle-orm";
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

describe("ThreadViews close and lock state", () => {
	const OPENER = "did:plc:7fkdlwjqmzcuvvpjbztkoooo";

	const member = (actor: string): ActorAuthz => ({
		community: COMMUNITY,
		actor,
		member: { did: actor, roles: [], joinedAt: NOW, nickname: null },
		isOwner: false,
		isBanned: false,
		roles: [],
	});

	const putOpenedThread = async (values: { closedAt?: string; locked?: boolean } = {}) => {
		await database.db.insert(database.tables.threads).values({
			space: THREAD,
			community: COMMUNITY,
			channel: SPACE,
			skey: THREAD_SKEY,
			name: "side conversation",
			createdBy: OPENER,
			createdAt: NOW,
			visibleToRoles: [],
			visibleToMembers: [],
			lastActivityAt: NOW,
			indexedAt: NOW,
			...values,
		});
	};

	it("serves closedAt and locked", async () => {
		await putOpenedThread({ closedAt: NOW, locked: true });

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.closedAt).toBe(NOW);
		expect(view?.locked).toBe(true);
	});

	it("leaves closedAt and locked out of an open thread", async () => {
		await putOpenedThread();

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.closedAt).toBeUndefined();
		expect(view?.locked).toBeUndefined();
	});

	it("gives the opener edit, close and delete rights", async () => {
		await putOpenedThread();

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.viewer).toMatchObject({
			canManage: false,
			canEdit: true,
			canClose: true,
			canDelete: true,
			canLock: false,
			canPost: true,
		});
	});

	it("gives another member no management rights", async () => {
		await putOpenedThread();

		const view = await threads.view((await threads.row(THREAD))!, member(AUTHOR), AUTHOR);

		expect(view?.viewer).toMatchObject({
			canEdit: false,
			canClose: false,
			canDelete: false,
			canLock: false,
		});
	});

	it("stops the opener posting in or closing a locked thread", async () => {
		await putOpenedThread({ locked: true });

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.viewer).toMatchObject({ canPost: false, canClose: false, canDelete: true });
	});

	it("stops a member posting in a thread of a read-only channel", async () => {
		await database.db
			.update(database.tables.channels)
			.set({ ownerOnly: true })
			.where(eq(database.tables.channels.space, SPACE));
		await putOpenedThread();

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.viewer).toMatchObject({ canRead: true, canPost: false });
	});

	it("stops a member posting in a thread of a channel its category makes read-only", async () => {
		await database.db.insert(database.tables.categories).values({
			community: COMMUNITY,
			rkey: "3lkcategory0000",
			name: "announcements",
			ownerOnly: true,
		});
		await database.db
			.update(database.tables.channels)
			.set({ category: "3lkcategory0000" })
			.where(eq(database.tables.channels.space, SPACE));
		await putOpenedThread();

		const view = await threads.view((await threads.row(THREAD))!, member(OPENER), OPENER);

		expect(view?.viewer).toMatchObject({ canRead: true, canPost: false });
	});
});

describe("ThreadViews members", () => {
	const POSTER = "did:plc:7fkdlwjqmzcuvvpjbztkbbbb";
	const PINGED = "did:plc:7fkdlwjqmzcuvvpjbztkcccc";
	const ROLE_HOLDER = "did:plc:7fkdlwjqmzcuvvpjbztkdddd";
	const FOLLOWER = "did:plc:7fkdlwjqmzcuvvpjbztkeeee";
	const BYSTANDER = "did:plc:7fkdlwjqmzcuvvpjbztkffff";
	const OUTSIDER = "did:plc:7fkdlwjqmzcuvvpjbztkgggg";
	const ROLE = "3lkroletest0000";

	const putMember = async (did: string, roles: string[] = []) => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did,
			roles,
			joinedAt: NOW,
		});
	};

	const putRole = async (mentionable: boolean, isDefault = false) => {
		await database.db.insert(database.tables.roles).values({
			community: COMMUNITY,
			rkey: ROLE,
			name: "helpers",
			permissions: [],
			position: 1,
			mentionable,
			isDefault,
		});
	};

	const postInThread = async (author: string, facets: unknown[] = []) => {
		await database.db.insert(database.tables.messages).values({
			space: THREAD,
			author,
			rkey: nextTid(),
			community: COMMUNITY,
			text: "in the thread",
			facets,
			createdAt: NOW,
			fromLegacyRepo: false,
			indexedAt: NOW,
		});
	};

	const mention = (did: string) => ({
		index: { byteStart: 0, byteEnd: 1 },
		features: [{ $type: "social.colibri.beta.richtext.facet#mention", did }],
	});

	const roleMention = (role: string) => ({
		index: { byteStart: 0, byteEnd: 1 },
		features: [{ $type: "social.colibri.beta.richtext.facet#role", role }],
	});

	beforeEach(async () => {
		for (const did of [AUTHOR, POSTER, PINGED, FOLLOWER, BYSTANDER]) await putMember(did);
		await putMember(ROLE_HOLDER, [ROLE]);
	});

	it("lists the anchor author, posters, mentions, role mentions and followers", async () => {
		await putRole(true);
		const rkey = nextTid();
		await putMessage(rkey);
		await putThread(rkey);
		await postInThread(POSTER, [mention(PINGED), roleMention(ROLE), mention(OUTSIDER)]);
		await database.db
			.insert(database.tables.threadFollows)
			.values({ space: THREAD, did: FOLLOWER, createdAt: NOW });

		const members = await threads.members((await threads.row(THREAD))!);

		expect(members).toEqual([AUTHOR, POSTER, PINGED, ROLE_HOLDER, FOLLOWER]);
	});

	it("leaves out members who left the thread unless they follow it", async () => {
		await putThread();
		await postInThread(POSTER, [mention(PINGED)]);
		await database.db
			.insert(database.tables.threadFollows)
			.values({ space: THREAD, did: FOLLOWER, createdAt: NOW });
		await database.db.insert(database.tables.leftThreads).values([
			{ did: POSTER, space: THREAD, leftAt: NOW },
			{ did: PINGED, space: THREAD, leftAt: NOW },
			{ did: FOLLOWER, space: THREAD, leftAt: NOW },
		]);

		const members = await threads.members((await threads.row(THREAD))!);

		expect(members).toEqual([FOLLOWER]);
	});

	it("skips a mention of the default role even when it claims to be mentionable", async () => {
		await putRole(true, true);
		await putThread();
		await postInThread(POSTER, [roleMention(ROLE)]);

		const members = await threads.members((await threads.row(THREAD))!);

		expect(members).toEqual([POSTER]);
	});

	it("skips a role mention the author may not make", async () => {
		await putRole(false);
		await putThread();
		await postInThread(POSTER, [roleMention(ROLE)]);

		const members = await threads.members((await threads.row(THREAD))!);

		expect(members).toEqual([POSTER]);
	});

	it("leaves out members who may not read a private thread", async () => {
		await putThread();
		await database.db.update(database.tables.threads).set({ visibleToMembers: [POSTER] });
		await postInThread(POSTER, [mention(PINGED)]);

		const members = await threads.members((await threads.row(THREAD))!);

		expect(members).toEqual([POSTER]);
	});
});

describe("ThreadViews last message", () => {
	const READER = "did:plc:7fkdlwjqmzcuvvpjbztkrrrr";
	const LABELER = "did:plc:7fkdlwjqmzcuvvpjbztkllll";

	const reader = (): ActorAuthz => ({
		community: COMMUNITY,
		actor: READER,
		member: { did: READER, roles: [], joinedAt: NOW, nickname: null },
		isOwner: false,
		isBanned: false,
		roles: [],
	});

	const postInThread = async (
		rkey: string,
		values: { text?: string; facets?: unknown[]; createdAt?: string } = {},
	) => {
		await database.db.insert(database.tables.messages).values({
			space: THREAD,
			author: AUTHOR,
			rkey,
			community: COMMUNITY,
			text: values.text ?? "in the thread",
			facets: values.facets,
			createdAt: values.createdAt ?? NOW,
			fromLegacyRepo: false,
			indexedAt: NOW,
		});
	};

	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: READER,
			roles: [],
			joinedAt: NOW,
		});
	});

	const asThreadView = (body: unknown): void => {
		const result = social.colibri.beta.thread.defs.threadView.safeValidate(body);
		if (!result.success) throw new Error(result.reason.message);
	};

	const lastMessage = async () =>
		(await threads.view((await threads.row(THREAD))!, reader(), READER))?.lastMessage;

	it("summarizes the latest message in the thread", async () => {
		await putThread();
		await postInThread(nextTid(), { text: "older" });
		const latest = nextTid();
		await postInThread(latest, { text: "newest", createdAt: "2026-08-24T00:00:00.000Z" });

		const view = await threads.view((await threads.row(THREAD))!, reader(), READER);

		asThreadView(view);
		expect(view?.lastMessage).toEqual({
			channel: THREAD,
			rkey: latest,
			author: AUTHOR,
			text: "newest",
			attachmentCount: 0,
			forward: false,
			createdAt: "2026-08-24T00:00:00.000Z",
		});
	});

	it("leaves lastMessage out of a thread with no messages", async () => {
		await putThread();

		const view = await threads.view((await threads.row(THREAD))!, reader(), READER);

		expect(view).not.toBeNull();
		expect(view?.lastMessage).toBeUndefined();
	});

	it("skips a withheld message", async () => {
		await putThread();
		await database.db
			.update(database.tables.communities)
			.set({ labelers: [LABELER] })
			.where(eq(database.tables.communities.did, COMMUNITY));
		const visible = nextTid();
		const hidden = nextTid();
		await postInThread(visible);
		await postInThread(hidden);
		await database.db.insert(database.tables.labels).values({
			space: THREAD,
			src: LABELER,
			rkey: nextTid(),
			subjectDid: AUTHOR,
			subjectCollection: COLLECTIONS.message,
			subjectRkey: hidden,
			val: "hidden",
			negated: false,
			createdAt: NOW,
		});

		expect((await lastMessage())?.rkey).toBe(visible);
	});

	it("drops custom emoji the community's policy disallows", async () => {
		await putThread();
		await database.db
			.update(database.tables.communities)
			.set({ customEmoji: "none" })
			.where(eq(database.tables.communities.did, COMMUNITY));
		await postInThread(nextTid(), {
			text: ":kek:",
			facets: [
				{
					index: { byteStart: 0, byteEnd: 5 },
					features: [
						{
							$type: "social.colibri.beta.richtext.facet#customEmoji",
							uri: `at://${COMMUNITY}/blue.moji.collection.item/kek`,
						},
					],
				},
			],
		});

		const summary = await lastMessage();

		expect(summary?.text).toBe(":kek:");
		expect(summary).not.toHaveProperty("facets");
	});
});
