import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import type { RepoChange } from "@colibri-social/space-sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { connectPipeline } from "./pipeline.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

const stalledIndexing = { enabled: false };

vi.mock("@colibri-social/notifications", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@colibri-social/notifications")>();
	return {
		...actual,
		indexMessage: (...args: Parameters<typeof actual.indexMessage>) =>
			stalledIndexing.enabled ? new Promise<never>(() => {}) : actual.indexMessage(...args),
	};
});

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const LABELER = "did:plc:labelerlabelerlabelerlabl";
const CHANNEL_SKEY = "3lkpipelinetest";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let published: { space: string; frame: ServerFrame }[];
let emit: (change: RepoChange) => void;
let emitSpaceDeleted: (uri: string) => void;
let disconnect: () => void;

const framesOfType = (suffix: string) =>
	published.filter((entry) => entry.frame.$type === `social.colibri.beta.sync.defs#${suffix}`);

const putMessageRow = async (rkey: string, text = "hello") => {
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text,
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
	});
};

const putLabelRow = async (subjectRkey: string, val: string, negated = false) => {
	await database.db.insert(database.tables.labels).values({
		space: SPACE,
		src: LABELER,
		rkey: nextTid(),
		subjectDid: AUTHOR,
		subjectCollection: COLLECTIONS.message,
		subjectRkey,
		val,
		negated,
		createdAt: NOW,
	});
};

const messageChange = (rkey: string): RepoChange => ({
	space: SPACE,
	author: AUTHOR,
	puts: [
		{
			collection: COLLECTIONS.message,
			rkey,
			cid: "bafyreictest",
			value: { $type: COLLECTIONS.message, text: "hello", createdAt: NOW },
		},
	],
	deletes: [],
});

const labelChange = (subjectRkey: string, val: string, neg: boolean): RepoChange => ({
	space: SPACE,
	author: LABELER,
	puts: [
		{
			collection: COLLECTIONS.label,
			rkey: nextTid(),
			cid: "bafyreictestlabel",
			value: {
				$type: COLLECTIONS.label,
				subject: { did: AUTHOR, collection: COLLECTIONS.message, rkey: subjectRkey },
				val,
				neg,
				createdAt: NOW,
			},
		},
	],
	deletes: [],
});

beforeEach(async () => {
	database = await openTestDatabase();
	published = [];

	const ctx = {
		database,
		config: { PUBLIC_URL: "https://appview.test", notifications: {}, pushProviders: [] },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		log: { warn: () => {}, debug: () => {} },
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
		},
		sync: {
			on: (event: string, listener: (arg: never) => void) => {
				if (event === "changed") emit = listener as (change: RepoChange) => void;
				if (event === "spaceDeleted") emitSpaceDeleted = listener as (uri: string) => void;
				return () => {};
			},
		},
	} as unknown as AppContext;

	const events = {
		publishToChannel: (space: string, frame: ServerFrame) => published.push({ space, frame }),
		publishToCommunity: (community: string, frame: ServerFrame) =>
			published.push({ space: community, frame }),
		publishToUser: (did: string, frame: ServerFrame) => published.push({ space: did, frame }),
		channelChanged: (community: string, space: string, event: "update" | "delete") =>
			published.push({
				space,
				frame: {
					$type: "social.colibri.beta.sync.defs#channelEvent",
					event,
					community,
					space,
				},
			}),
	} as unknown as EventServer;

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test Community",
		labelers: [LABELER],
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

	disconnect = connectPipeline({ ctx, events });
});

afterEach(async () => {
	stalledIndexing.enabled = false;
	disconnect();
	await database.destroy();
});

describe("connectPipeline", () => {
	it("publishes a hydrated message with its labels", async () => {
		const rkey = nextTid();
		await putMessageRow(rkey);
		await putLabelRow(rkey, "spoiler");

		emit(messageChange(rkey));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		const frame = framesOfType("messageEvent")[0]?.frame;
		expect(frame).toMatchObject({ event: "create", channel: SPACE });

		const message = frame?.message as { rkey: string; text: string; labels: unknown[] };
		expect(message).toMatchObject({ rkey, text: "hello" });
		expect(message.labels).toEqual([expect.objectContaining({ src: LABELER, val: "spoiler" })]);
	});

	it("publishes the message before notification indexing settles", async () => {
		const rkey = nextTid();
		await putMessageRow(rkey);
		stalledIndexing.enabled = true;

		emit(messageChange(rkey));

		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));
	});

	it("publishes the visible message of a batch and withholds the hidden one", async () => {
		const hiddenRkey = nextTid();
		const visibleRkey = nextTid();
		await putMessageRow(hiddenRkey, "spam");
		await putMessageRow(visibleRkey, "fine");
		await putLabelRow(hiddenRkey, "hidden");

		const change = messageChange(hiddenRkey);
		emit({ ...change, puts: [...change.puts, ...messageChange(visibleRkey).puts] });

		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));
		expect(framesOfType("messageEvent")[0]?.frame.message).toMatchObject({
			rkey: visibleRkey,
			text: "fine",
		});
	});

	it("publishes a labelEvent when a label lands", async () => {
		const rkey = nextTid();
		await putMessageRow(rkey);

		emit(labelChange(rkey, "hidden", false));
		await vi.waitFor(() => expect(framesOfType("labelEvent")).toHaveLength(1));

		expect(framesOfType("labelEvent")[0]?.frame).toMatchObject({
			event: "create",
			space: SPACE,
			val: "hidden",
			src: LABELER,
			subject: { did: AUTHOR, rkey },
		});
	});

	it("re-publishes the message when a hidden label is negated", async () => {
		const rkey = nextTid();
		await putMessageRow(rkey);

		emit(labelChange(rkey, "hidden", true));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		expect(framesOfType("labelEvent")[0]?.frame).toMatchObject({ event: "negate" });
		expect(framesOfType("messageEvent")[0]?.frame.message).toMatchObject({ rkey });
	});

	it("publishes a bare reference on delete", async () => {
		const rkey = nextTid();
		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [],
			deletes: [{ collection: COLLECTIONS.message, rkey }],
		});
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		expect(framesOfType("messageEvent")[0]?.frame).toMatchObject({
			event: "delete",
			subject: { did: AUTHOR, rkey },
		});
	});
});

describe("configuration events", () => {
	const CONFIG_SPACE = `at://${COMMUNITY}/space/${SPACE_TYPES.communityConfiguration}/self`;

	it("tells the channel's readers that its record landed", async () => {
		emit({
			space: SPACE,
			author: COMMUNITY,
			puts: [
				{
					collection: COLLECTIONS.channel,
					rkey: "self",
					cid: "bafyreictestchannel",
					value: { $type: COLLECTIONS.channel, name: "general" },
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(framesOfType("channelEvent")).toHaveLength(1));

		expect(framesOfType("channelEvent")[0]).toMatchObject({
			space: SPACE,
			frame: { event: "update", community: COMMUNITY, space: SPACE },
		});
	});

	it("tells the community a category record landed", async () => {
		const rkey = nextTid();
		emit({
			space: CONFIG_SPACE,
			author: COMMUNITY,
			puts: [
				{
					collection: COLLECTIONS.category,
					rkey,
					cid: "bafyreictestcategory",
					value: { $type: COLLECTIONS.category, name: "Text channels", channelOrder: [] },
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(framesOfType("categoryEvent")).toHaveLength(1));

		expect(framesOfType("categoryEvent")[0]?.frame).toMatchObject({
			event: "update",
			community: COMMUNITY,
		});
	});

	it("names the channel that went when its space is deleted", async () => {
		emitSpaceDeleted(SPACE);
		await vi.waitFor(() => expect(framesOfType("channelEvent")).toHaveLength(1));

		expect(framesOfType("channelEvent")[0]?.frame).toMatchObject({
			event: "delete",
			community: COMMUNITY,
			space: SPACE,
		});
	});

	it("says nothing when a community's own space is deleted", async () => {
		emitSpaceDeleted(CONFIG_SPACE);

		expect(framesOfType("channelEvent")).toHaveLength(0);
	});
});

describe("personal space events", () => {
	const PREFERENCES = `at://${AUTHOR}/space/${SPACE_TYPES.actorPreferences}/self`;

	it("tells the actor's own devices when their preferences change", async () => {
		emit({
			space: PREFERENCES,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.settings,
					rkey: "self",
					cid: "bafyreictestsettings",
					value: { $type: COLLECTIONS.settings, notificationLevel: "all" },
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(framesOfType("preferencesEvent")).toHaveLength(1));

		expect(framesOfType("preferencesEvent")[0]?.space).toBe(AUTHOR);
	});
});
