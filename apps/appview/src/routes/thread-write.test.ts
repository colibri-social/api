import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import {
	CommunityLoader,
	type CommunityWriter,
	Membership,
	Moderation,
	type RecordWrite,
} from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	communitySpaces,
	LABEL_VALUES,
	SPACE_TYPES,
} from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Announcer, silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { ThreadViews } from "../views/thread.js";
import type { ServerFrame } from "../ws/events.js";
import { moveMessages } from "./thread-write.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const MOVER = "did:plc:7fkdlwjqmzcuvvpjbztkmmmm";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const VIEWER = "did:plc:7fkdlwjqmzcuvvpjbztkvvvv";
const NOW = "2026-08-23T00:00:00.000Z";
const SOURCE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchannelsrc00");
const DESTINATION = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkchanneldst00");

type Published = { space: string; frame: ServerFrame };

let database: TestDatabase;
let ctx: AppContext;
let published: Published[];
let writes: RecordWrite[];

const recordingAnnouncer = (): Announcer => ({
	...silentAnnouncer,
	toChannel: (space, frame) => {
		published.push({ space, frame: typeof frame === "function" ? frame(VIEWER) : frame });
	},
});

const fakeWriter = (): CommunityWriter =>
	({
		spaces: (community: string) => communitySpaces(community),
		put: async (community: string, write: RecordWrite) => {
			writes.push(write);
			const rkey = write.rkey ?? nextTid();
			return { uri: `at://${community}/${write.collection}/${rkey}`, rkey };
		},
	}) as unknown as CommunityWriter;

const putChannel = (space: string, skey: string) =>
	database.db.insert(database.tables.channels).values({
		space,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey,
		name: skey,
	});

const putMessage = async (rkey: string) => {
	await database.db.insert(database.tables.messages).values({
		space: SOURCE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "moving along",
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
	});
};

const move = (rkeys: string[]) => {
	const writer = fakeWriter();
	const channels = new ChannelViews(ctx, new ActorViews(ctx));
	const membership = new Membership({
		db: database.db,
		tables: database.tables,
		loader: ctx.loader,
		writer,
	});
	const moderation = new Moderation({
		db: database.db,
		tables: database.tables,
		loader: ctx.loader,
		writer,
		membership,
	});
	return moveMessages(
		{ ctx, channels, threads: new ThreadViews(ctx, channels), moderation },
		MOVER,
		{
			source: SOURCE,
			destination: DESTINATION,
			subjects: rkeys.map((rkey) => ({ did: AUTHOR, collection: COLLECTIONS.message, rkey })),
		} as Parameters<typeof moveMessages>[2],
	);
};

beforeEach(async () => {
	database = await openTestDatabase();
	published = [];
	writes = [];
	ctx = {
		announce: recordingAnnouncer(),
		database,
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		writer: fakeWriter(),
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

	const spaces = communitySpaces(COMMUNITY);
	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test",
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});
	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey: "movers",
		name: "movers",
		color: null,
		permissions: ["thread.move"],
		position: 10,
		hoisted: false,
		mentionable: false,
		protected: false,
		channelOverrides: [],
	});
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did: MOVER,
		roles: ["movers"],
		joinedAt: NOW,
		nickname: null,
	});
	await putChannel(SOURCE, "3lkchannelsrc00");
	await putChannel(DESTINATION, "3lkchanneldst00");
});

afterEach(async () => {
	await database.destroy();
});

describe("moving messages", () => {
	it("labels each message in its source and announces it in the destination", async () => {
		const first = nextTid();
		const second = nextTid();
		await putMessage(first);
		await putMessage(second);

		const result = await move([first, second]);

		expect(result.count).toBe(2);
		const labels = published.filter(({ frame }) => frame.$type.endsWith("#labelEvent"));
		expect(labels).toEqual(
			[first, second].map((rkey) => ({
				space: SOURCE,
				frame: expect.objectContaining({
					event: "create",
					space: SOURCE,
					val: LABEL_VALUES.moved,
					subject: expect.objectContaining({ did: AUTHOR, rkey }),
				}),
			})),
		);
		const arrivals = published.filter(({ frame }) => frame.$type.endsWith("#messageEvent"));
		expect(arrivals).toEqual(
			[first, second].map((rkey) => ({
				space: DESTINATION,
				frame: expect.objectContaining({
					event: "create",
					channel: DESTINATION,
					message: expect.objectContaining({ rkey }),
				}),
			})),
		);
	});

	it("writes a moved label that points at the destination", async () => {
		const rkey = nextTid();
		await putMessage(rkey);

		await move([rkey]);

		expect(writes.filter((write) => write.collection === COLLECTIONS.label)).toEqual([
			expect.objectContaining({
				space: SOURCE,
				record: expect.objectContaining({ val: LABEL_VALUES.moved, destination: DESTINATION }),
			}),
		]);
	});
});
