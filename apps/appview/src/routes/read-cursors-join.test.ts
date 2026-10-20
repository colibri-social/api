import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	CommunityLoader,
	type CommunityWriter,
	Membership,
	type RecordWrite,
} from "@colibri-social/community";
import { COLLECTIONS, channelSpace, communitySpaces, SPACE_TYPES } from "@colibri-social/lexicons";
import { nextTid, tidAt } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import type { ServerFrame } from "../ws/events.js";
import { handleJoinCommunity } from "./community-write.js";
import { handleApproveApplication } from "./moderation.js";

vi.mock("../push-delivery.js", () => ({
	pushDelivery: () => ({ readMoved: () => {} }),
}));

const NOW = new Date("2026-10-15T00:00:00.000Z");
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OWNER = "did:plc:ownerxxxxxxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxxxx";
const JOINER = "did:plc:joinerxxxxxxxxxxxxxxxxxxxxxxx";
const GENERAL = "3lkchannel1";
const RANDOM = "3lkchannel2";
const SECRET = "3lkchannel3";

let database: TestDatabase;
let ctx: AppContext;
let actors: ActorViews;
let channels: ChannelViews;
let membership: Membership;
let announced: { did: string; frame: ServerFrame }[];
let warnings: { detail: Record<string, unknown>; event: string }[];

const space = (skey: string) => channelSpace(COMMUNITY, SPACE_TYPES.channelText, skey);

const fakeWriter = (): CommunityWriter =>
	({
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			if (write.collection === COLLECTIONS.member) {
				const record = write.record as { subject: string; roles?: string[]; joinedAt: string };
				await database.db.insert(database.tables.members).values({
					community,
					did: record.subject,
					roles: record.roles ?? [],
					joinedAt: record.joinedAt,
					nickname: null,
				});
			}
			return { uri: `at://${community}/${write.collection}/${write.rkey}`, rkey: write.rkey };
		},
	}) as unknown as CommunityWriter;

const addChannel = (skey: string, visibleToRoles: string[] = []) =>
	database.db.insert(database.tables.channels).values({
		space: space(skey),
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey,
		name: skey,
		description: null,
		category: null,
		position: 0,
		ownerOnly: false,
		allowedRoles: [],
		allowedMembers: [],
		visibleToRoles,
		visibleToMembers: [],
		linkEmbeds: null,
		migratedFrom: null,
	});

const post = (skey: string, rkey: string) =>
	database.db.insert(database.tables.messages).values({
		space: space(skey),
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "hello",
		createdAt: NOW.toISOString(),
		fromLegacyRepo: false,
		indexedAt: NOW.toISOString(),
	});

const stored = async () =>
	(
		await database.db
			.select({
				channel: database.tables.readCursors.channel,
				cursor: database.tables.readCursors.cursor,
			})
			.from(database.tables.readCursors)
			.where(eq(database.tables.readCursors.did, JOINER))
	).sort((a, b) => a.channel.localeCompare(b.channel));

const unread = async () =>
	(await channels.unreadStatus(JOINER, { community: COMMUNITY }))
		.filter((status) => status.hasUnread)
		.map((status) => status.channel);

beforeEach(async () => {
	database = await openTestDatabase();
	announced = [];
	warnings = [];

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	membership = new Membership({
		db: database.db,
		tables: database.tables,
		loader,
		writer: fakeWriter(),
		now: () => NOW,
	});

	ctx = {
		announce: {
			...silentAnnouncer,
			toUser: (did: string, frame: ServerFrame) => announced.push({ did, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test" },
		database,
		loader,
		log: {
			warn: (detail: Record<string, unknown>, event: string) => warnings.push({ detail, event }),
		},
		identity: {
			resolveDid: async () => null,
			resolveVerifiedHandle: async () => null,
			resolveVerifiedHandles: async () => new Map(),
		},
	} as unknown as AppContext;
	actors = new ActorViews(ctx);
	channels = new ChannelViews(ctx, actors);

	const spaces = communitySpaces(COMMUNITY);
	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Protocol Nerds",
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW.toISOString(),
	});
	await database.db.insert(database.tables.roles).values([
		{
			community: COMMUNITY,
			rkey: "owner",
			name: "owner",
			color: null,
			permissions: ["approval.manage"],
			position: 1000,
			hoisted: false,
			mentionable: false,
			protected: true,
			channelOverrides: [],
		},
		{
			community: COMMUNITY,
			rkey: "member",
			name: "member",
			color: null,
			permissions: [],
			position: 0,
			hoisted: false,
			mentionable: false,
			protected: false,
			isDefault: true,
			channelOverrides: [],
		},
	]);
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did: OWNER,
		roles: ["owner"],
		joinedAt: NOW.toISOString(),
		nickname: null,
	});
	await addChannel(GENERAL);
	await addChannel(RANDOM);
	await addChannel(SECRET, ["owner"]);
	await post(GENERAL, tidAt("2026-10-01T00:00:00.000Z", "general"));
	await post(RANDOM, tidAt("2026-10-02T00:00:00.000Z", "random"));
	await post(SECRET, tidAt("2026-10-03T00:00:00.000Z", "secret"));
});

afterEach(async () => {
	await database.destroy();
});

const expectSeeded = async () => {
	const cursors = await stored();
	expect(cursors.map((entry) => entry.channel)).toEqual([GENERAL, RANDOM]);
	const [first] = cursors;
	expect(cursors.every((entry) => entry.cursor === first?.cursor)).toBe(true);

	expect(announced).toContainEqual({
		did: JOINER,
		frame: {
			$type: "social.colibri.beta.sync.defs#readCursorEvent",
			community: COMMUNITY,
			cursors,
		},
	});

	expect(await unread()).toEqual([]);

	await post(GENERAL, nextTid());
	expect(await unread()).toEqual([space(GENERAL)]);
};

describe("read cursors on join", () => {
	it("marks every readable channel read when a member joins directly", async () => {
		const result = await handleJoinCommunity(ctx, actors, membership, JOINER, COMMUNITY);

		expect(result.status).toBe("joined");
		await expectSeeded();
	});

	it("marks every readable channel read when an application is approved", async () => {
		await database.db.update(database.tables.communities).set({ requiresApproval: true });
		const applied = await handleJoinCommunity(ctx, actors, membership, JOINER, COMMUNITY);
		expect(applied.status).toBe("pending");
		expect(await stored()).toEqual([]);

		await handleApproveApplication(ctx, actors, membership, OWNER, COMMUNITY, JOINER);

		await expectSeeded();
	});

	it("keeps the join when seeding fails and logs the failure", async () => {
		const failure = new Error("authz unavailable");
		const failing = {
			...ctx,
			loader: {
				authz: async () => {
					throw failure;
				},
			},
		} as unknown as AppContext;

		const result = await handleJoinCommunity(failing, actors, membership, JOINER, COMMUNITY);

		expect(result.status).toBe("joined");
		expect(await stored()).toEqual([]);
		expect(warnings).toEqual([
			{
				detail: { community: COMMUNITY, did: JOINER, error: failure },
				event: "readCursors.seedOnJoinFailed",
			},
		]);
	});
});
