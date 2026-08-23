import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { COLLECTIONS, channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import type { RepoChange } from "@colibri-social/space-sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { connectPipeline } from "./pipeline.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const LABELER = "did:plc:labelerlabelerlabelerlabl";
const CHANNEL_SKEY = "3lkpipelinetest";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let published: { space: string; frame: ServerFrame }[];
let emit: (change: RepoChange) => void;
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
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		log: { warn: () => {} },
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
		},
		sync: {
			on: (event: string, listener: (change: RepoChange) => void) => {
				if (event === "changed") emit = listener;
				return () => {};
			},
		},
	} as unknown as AppContext;

	const events = {
		publishToChannel: (space: string, frame: ServerFrame) => published.push({ space, frame }),
		publishToCommunity: (community: string, frame: ServerFrame) =>
			published.push({ space: community, frame }),
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
