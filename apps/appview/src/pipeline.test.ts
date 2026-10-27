import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { createTtlCache, type LinkEmbed } from "@colibri-social/embeds";
import { COLLECTIONS, channelSpace, SPACE_TYPES, threadSpace } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import type { RepoChange } from "@colibri-social/space-sync";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { createLinkEmbedResolver } from "./link-embeds.js";
import type { Logger } from "./logger.js";
import { verifyMediaGrant } from "./media-token.js";
import { connectPipeline } from "./pipeline.js";
import type { ChannelFrame, EventServer, ServerFrame } from "./ws/events.js";

const stalledIndexing = { enabled: false };
const pushed = vi.hoisted(() => ({
	deleted: [] as unknown[],
	edited: [] as unknown[],
	readMoved: [] as unknown[][],
	notified: [] as string[],
	notifiedMessages: [] as unknown[],
}));

vi.mock("@colibri-social/notifications", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@colibri-social/notifications")>();
	return {
		...actual,
		indexMessage: (...args: Parameters<typeof actual.indexMessage>) =>
			stalledIndexing.enabled ? new Promise<never>(() => {}) : actual.indexMessage(...args),
		deliverMessageDeleted: async (_deps: unknown, _senders: unknown, message: unknown) => {
			pushed.deleted.push(message);
			return 0;
		},
		deliverNotification: async (
			_deps: unknown,
			_senders: unknown,
			row: { recipient: string },
			message: unknown,
		) => {
			pushed.notified.push(row.recipient);
			pushed.notifiedMessages.push(message);
		},
		deliverMessageEdited: async (
			_deps: unknown,
			_senders: unknown,
			message: unknown,
			sender: unknown,
			options?: { reaches?: (recipient: string) => boolean },
		) => {
			pushed.edited.push({ message, sender, reaches: options?.reaches });
			return 0;
		},
	};
});

vi.mock("./push-delivery.js", () => ({
	pushDelivery: () => ({
		enabled: true,
		senders: {},
		options: {},
		readMoved: (...args: unknown[]) => pushed.readMoved.push(args),
		close: () => {},
	}),
}));

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const LABELER = "did:plc:labelerlabelerlabelerlabl";
const CHANNEL_SKEY = "3lkpipelinetest";
const VIEWER = "did:plc:viewerviewerviewerviewer";
const SIGNING_KEY = "f".repeat(64);
const ATTACHMENT_CID = "bafkreiattachmentxxxxxxxxxxxxxxxxxxxx";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, CHANNEL_SKEY);
const OTHER_SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkpipelineother");
const OTHER_AUTHOR = "did:plc:originalauthor000000000";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let published: { space: string; frame: ServerFrame }[];
let emit: (change: RepoChange) => void;
let emitSpaceDeleted: (uri: string) => void;
let disconnect: () => void;
let communityDeletes: string[];
let authzChanges: string[];
let forgotten: string[];
let releasePreview: () => void;
let threadWrites: { community: string; space: string; record: Record<string, unknown> }[];
let voicePresence: Map<string, string>;

const framesOfType = (suffix: string) =>
	published.filter((entry) => entry.frame.$type === `social.colibri.beta.sync.defs#${suffix}`);

const putMessageRow = async (rkey: string, text = "hello", attachments?: unknown[]) => {
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text,
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
		...(attachments ? { attachments } : {}),
	});
};

const putAttachedMessageRow = (rkey: string) =>
	putMessageRow(rkey, "look at this", [
		{
			blob: { ref: { $link: ATTACHMENT_CID }, mimeType: "image/png", size: 1234 },
			name: "cat.png",
		},
	]);

const putForwardedMessageRow = async (rkey: string, mentioned: string, attachments?: unknown[]) => {
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "",
		createdAt: NOW,
		forward: {
			source: { space: OTHER_SPACE, did: OTHER_AUTHOR, rkey: "3lkmsgsource" },
			createdAt: NOW,
			text: "the original",
			facets: [mentionFacet(mentioned)],
			...(attachments ? { attachments } : {}),
		},
		fromLegacyRepo: false,
		indexedAt: NOW,
	});
};

const notificationsFor = (recipient: string) =>
	database.db
		.select()
		.from(database.tables.notifications)
		.where(eq(database.tables.notifications.recipient, recipient));

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

const mentionFacet = (did: string) => ({
	index: { byteStart: 0, byteEnd: 1 },
	features: [{ $type: "social.colibri.beta.richtext.facet#mention", did }],
});

const forwardedMessageChange = (rkey: string, mentioned: string): RepoChange => ({
	space: SPACE,
	author: AUTHOR,
	puts: [
		{
			collection: COLLECTIONS.message,
			rkey,
			cid: "bafyreictestforward",
			value: {
				$type: COLLECTIONS.message,
				text: "",
				createdAt: NOW,
				forward: {
					source: { space: OTHER_SPACE, did: OTHER_AUTHOR, rkey: "3lkmsgsource" },
					createdAt: NOW,
					text: "the original",
					facets: [mentionFacet(mentioned)],
				},
			},
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
	pushed.deleted = [];
	pushed.edited = [];
	pushed.readMoved = [];
	communityDeletes = [];
	authzChanges = [];
	forgotten = [];
	threadWrites = [];
	pushed.notified = [];
	pushed.notifiedMessages = [];
	voicePresence = new Map();

	const ctx = {
		database,
		config: {
			PUBLIC_URL: "https://appview.test",
			SIGNING_KEY,
			notifications: {},
			pushProviders: [],
		},
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		linkEmbeds: createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log: { debug: () => {} } as unknown as Logger,
			fetchPreview: (uri) =>
				new Promise<LinkEmbed>((resolve) => {
					releasePreview = () => resolve({ uri, siteName: "Tenor" });
				}),
		}),
		log: { warn: () => {}, debug: () => {} },
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
		sync: {
			on: (event: string, listener: (arg: never) => void) => {
				if (event === "changed") emit = listener as (change: RepoChange) => void;
				if (event === "spaceDeleted") emitSpaceDeleted = listener as (uri: string) => void;
				return () => {};
			},
			notifySpaceDeleted: (uri: string) => forgotten.push(uri),
		},
		authzChanges: {
			publish: (change: { community: string }) => authzChanges.push(change.community),
		},
		voice: { presenceOf: (did: string) => voicePresence.get(did) },
		projections: { now: () => new Date().toISOString() },
		writer: {
			put: async (community: string, write: { space: string; record: Record<string, unknown> }) => {
				threadWrites.push({ community, space: write.space, record: write.record });
			},
		},
	} as unknown as AppContext;

	const events = {
		publishToChannel: (space: string, frame: ChannelFrame) =>
			published.push({ space, frame: typeof frame === "function" ? frame(VIEWER) : frame }),
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
		communityDeleted: (community: string) => {
			communityDeletes.push(community);
			published.push({
				space: community,
				frame: {
					$type: "social.colibri.beta.sync.defs#communityEvent",
					event: "delete",
					community,
				},
			});
		},
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

	it("signs an attachment's media link for each subscriber", async () => {
		const rkey = nextTid();
		await putAttachedMessageRow(rkey);

		emit(messageChange(rkey));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		const message = framesOfType("messageEvent")[0]?.frame.message as {
			attachments: { url: string }[];
		};
		const url = new URL(message.attachments[0]?.url as string);
		expect(url.searchParams.get("viewer")).toBe(VIEWER);
		expect(
			verifyMediaGrant(
				SIGNING_KEY,
				{ did: AUTHOR, cid: ATTACHMENT_CID, space: SPACE, viewer: VIEWER },
				Number(url.searchParams.get("exp")),
				url.searchParams.get("sig") as string,
				Math.floor(Date.now() / 1000),
			),
		).toBe(true);
	});

	it("sends the full message with its signed attachments in the notification", async () => {
		const mentioned = "did:plc:mentionedmentionedment";
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: mentioned, roles: [], joinedAt: NOW },
		]);
		const rkey = nextTid();
		await putAttachedMessageRow(rkey);
		const change = messageChange(rkey);
		const put = change.puts[0] as { value: Record<string, unknown> };
		put.value.facets = [mentionFacet(mentioned)];

		emit(change);
		await vi.waitFor(() => expect(framesOfType("notificationEvent")).toHaveLength(1));

		const [entry] = framesOfType("notificationEvent");
		const notification = entry?.frame.notification as {
			message: { rkey: string; attachments: { url: string }[] };
		};
		expect(entry?.space).toBe(mentioned);
		expect(notification.message.rkey).toBe(rkey);
		expect(notification.message.attachments).toHaveLength(1);
		const url = new URL(notification.message.attachments[0]?.url as string);
		expect(url.searchParams.get("viewer")).toBe(mentioned);

		await vi.waitFor(() => expect(pushed.notifiedMessages).toHaveLength(1));
		const [pushedMessage] = pushed.notifiedMessages as {
			attachments: { mimeType: string; url: string }[];
		}[];
		expect(pushedMessage?.attachments).toEqual([
			{ mimeType: "image/png", url: notification.message.attachments[0]?.url },
		]);
	});

	it("never notifies or publishes a message the time guard refuses", async () => {
		const mentioned = "did:plc:mentionedmentionedment";
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: mentioned, roles: [], joinedAt: NOW },
		]);
		const refused = messageChange(nextTid());
		const refusedPut = refused.puts[0] as { value: Record<string, unknown> };
		refusedPut.value.createdAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		refusedPut.value.facets = [mentionFacet(mentioned)];
		const accepted = nextTid();
		const change = messageChange(accepted);
		(change.puts[0] as { value: Record<string, unknown> }).value.facets = [mentionFacet(mentioned)];
		await putMessageRow(accepted, "hello");

		emit(refused);
		emit(change);
		await vi.waitFor(() => expect(framesOfType("notificationEvent")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));

		const [entry, ...rest] = framesOfType("notificationEvent");
		expect(rest).toHaveLength(0);
		const notification = entry?.frame.notification as { message: { rkey: string } } | undefined;
		expect(notification?.message.rkey).toBe(accepted);
		expect(pushed.notified).toEqual([mentioned]);
	});

	it("never notifies or publishes a message a recovery replayed unchanged", async () => {
		const mentioned = "did:plc:mentionedmentionedment";
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: mentioned, roles: [], joinedAt: NOW },
		]);
		const replayed = messageChange(nextTid());
		const replayedPut = replayed.puts[0] as { value: Record<string, unknown>; replayed?: boolean };
		replayedPut.value.facets = [mentionFacet(mentioned)];
		replayedPut.replayed = true;
		const accepted = nextTid();
		const change = messageChange(accepted);
		(change.puts[0] as { value: Record<string, unknown> }).value.facets = [mentionFacet(mentioned)];
		await putMessageRow(accepted, "hello");

		emit(replayed);
		emit(change);
		await vi.waitFor(() => expect(framesOfType("notificationEvent")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(framesOfType("messageEvent")).toHaveLength(1);
		const [entry, ...rest] = framesOfType("notificationEvent");
		expect(rest).toHaveLength(0);
		const notification = entry?.frame.notification as { message: { rkey: string } } | undefined;
		expect(notification?.message.rkey).toBe(accepted);
		expect(pushed.notified).toEqual([mentioned]);
	});

	it("never notifies a mention that only appears inside a forwarded snapshot", async () => {
		const mentioned = "did:plc:mentionedmentionedment";
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: mentioned, roles: [], joinedAt: NOW },
		]);

		const rkey = nextTid();
		await putForwardedMessageRow(rkey, mentioned);

		emit(forwardedMessageChange(rkey, mentioned));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));
		await vi.waitFor(async () => expect(await notificationsFor(mentioned)).not.toHaveLength(0));

		const kinds = (await notificationsFor(mentioned)).map((row) => row.kind);
		expect(kinds).not.toContain("mention");
	});

	it("streams a message a bridge imported from earlier history without notifying", async () => {
		const mentioned = "did:plc:mentionedmentionedment";
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: mentioned, roles: [], joinedAt: NOW },
		]);
		const imported = nextTid();
		const live = nextTid();
		await putMessageRow(imported);
		await putMessageRow(live);

		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.message,
					rkey: imported,
					cid: "bafyreictestimported",
					value: {
						$type: COLLECTIONS.message,
						text: "@",
						facets: [mentionFacet(mentioned)],
						createdAt: NOW,
						bridged: {
							registration: "3lkregistration",
							platform: "test",
							remoteId: "1",
							name: "Nelly",
							imported: true,
						},
					},
				},
			],
			deletes: [],
		});
		emit(messageChange(live));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(2));

		const frames = framesOfType("messageEvent").map(
			(entry) => entry.frame as unknown as { message: { rkey: string }; imported?: boolean },
		);
		expect(frames.map((frame) => [frame.message.rkey, frame.imported])).toEqual([
			[imported, true],
			[live, undefined],
		]);
		const kinds = (await notificationsFor(mentioned)).map((row) => row.kind);
		expect(kinds).not.toContain("mention");
	});

	it("serves a forwarded snapshot with its source resolved", async () => {
		await database.db.insert(database.tables.channels).values({
			space: OTHER_SPACE,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelText,
			skey: "3lkpipelineother",
			name: "off-topic",
		});

		const rkey = nextTid();
		await putForwardedMessageRow(rkey, VIEWER);

		emit(forwardedMessageChange(rkey, VIEWER));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		const message = framesOfType("messageEvent")[0]?.frame.message as {
			forward: { text: string; sourceName?: string; sourceCommunity?: string };
		};
		expect(message.forward).toMatchObject({
			text: "the original",
			sourceName: "off-topic",
			sourceCommunity: COMMUNITY,
		});
	});

	it("signs a forwarded snapshot's attachment for each subscriber", async () => {
		const rkey = nextTid();
		await putForwardedMessageRow(rkey, VIEWER, [
			{
				blob: { ref: { $link: ATTACHMENT_CID }, mimeType: "image/png", size: 1234 },
				name: "cat.png",
			},
		]);

		emit(forwardedMessageChange(rkey, VIEWER));
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));

		const message = framesOfType("messageEvent")[0]?.frame.message as {
			forward: { attachments: { url: string }[] };
		};
		const url = new URL(message.forward.attachments[0]?.url as string);
		expect(url.searchParams.get("viewer")).toBe(VIEWER);
		expect(
			verifyMediaGrant(
				SIGNING_KEY,
				{ did: AUTHOR, cid: ATTACHMENT_CID, space: SPACE, viewer: VIEWER },
				Number(url.searchParams.get("exp")),
				url.searchParams.get("sig") as string,
				Math.floor(Date.now() / 1000),
			),
		).toBe(true);
	});

	it("publishes a message at once and again once its link preview resolves", async () => {
		const rkey = nextTid();
		const tenor = "https://tenor.com/view/touhou-fumo-plushie-plush-hello-gif-21004226";
		const facets = [
			{
				index: { byteStart: 0, byteEnd: tenor.length },
				features: [{ $type: "social.colibri.beta.richtext.facet#link", uri: tenor }],
			},
		];
		await putMessageRow(rkey, tenor);
		await database.db
			.update(database.tables.messages)
			.set({ facets })
			.where(eq(database.tables.messages.rkey, rkey));

		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.message,
					rkey,
					cid: "bafyreictestlink",
					value: { $type: COLLECTIONS.message, text: tenor, facets, createdAt: NOW },
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(1));
		const created = framesOfType("messageEvent")[0]?.frame;
		expect(created).toMatchObject({ event: "create" });
		expect(created?.message).toMatchObject({ embeds: undefined });

		releasePreview();
		await vi.waitFor(() => expect(framesOfType("messageEvent")).toHaveLength(2));

		const update = framesOfType("messageEvent")[1]?.frame;
		expect(update).toMatchObject({ event: "update", channel: SPACE });
		expect(update?.message).toHaveProperty("embeds", [
			expect.objectContaining({ uri: tenor, siteName: "Tenor" }),
		]);
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

	it("purges and announces a community whose profile space was deleted", async () => {
		const PROFILE_SPACE = `at://${COMMUNITY}/space/${SPACE_TYPES.communityProfile}/self`;

		emitSpaceDeleted(PROFILE_SPACE);
		await vi.waitFor(() => expect(communityDeletes).toEqual([COMMUNITY]));

		expect(authzChanges).toEqual([COMMUNITY]);
		expect(await database.db.select().from(database.tables.communities)).toEqual([]);
		expect(await database.db.select().from(database.tables.channels)).toEqual([]);
		expect(forgotten).toContain(SPACE);
	});

	it("stays quiet when the community row is already gone", async () => {
		const PROFILE_SPACE = `at://${COMMUNITY}/space/${SPACE_TYPES.communityProfile}/self`;
		await database.db.delete(database.tables.communities);

		emitSpaceDeleted(PROFILE_SPACE);
		await vi.waitFor(() => expect(framesOfType("channelEvent")).toHaveLength(0));

		expect(communityDeletes).toEqual([]);
		expect(authzChanges).toEqual([]);
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

	it("tells the actor's own devices about read cursors that arrive through sync", async () => {
		await database.db.insert(database.tables.readCursors).values({
			did: AUTHOR,
			community: COMMUNITY,
			channel: CHANNEL_SKEY,
			cursor: "3lkaaaaaaaaa7",
		});

		emit({
			space: PREFERENCES,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.channelRead,
					rkey: COMMUNITY,
					cid: "bafyreictestread",
					value: {
						$type: COLLECTIONS.channelRead,
						community: COMMUNITY,
						cursors: [{ channel: CHANNEL_SKEY, cursor: "3lkaaaaaaaaa2" }],
					},
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(framesOfType("readCursorEvent")).toHaveLength(1));

		expect(pushed.readMoved).toEqual([
			[AUTHOR, COMMUNITY, [{ channel: CHANNEL_SKEY, cursor: "3lkaaaaaaaaa2" }]],
		]);
		expect(framesOfType("readCursorEvent")[0]).toEqual({
			space: AUTHOR,
			frame: {
				$type: "social.colibri.beta.sync.defs#readCursorEvent",
				community: COMMUNITY,
				cursors: [{ channel: CHANNEL_SKEY, cursor: "3lkaaaaaaaaa7" }],
			},
		});
	});
});

describe("thread follow events", () => {
	const THREAD_SKEY = "3lkthreadfollow";
	const THREAD = threadSpace(COMMUNITY, THREAD_SKEY);

	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR,
			roles: [],
			joinedAt: NOW,
			nickname: null,
		});
		await database.db.insert(database.tables.threads).values({
			space: THREAD,
			community: COMMUNITY,
			channel: SPACE,
			skey: THREAD_SKEY,
			name: "release planning",
			createdBy: AUTHOR,
			createdAt: NOW,
			visibleToRoles: [],
			visibleToMembers: [],
			lastActivityAt: NOW,
			indexedAt: NOW,
		});
	});

	const followChange = (following: boolean): RepoChange => ({
		space: THREAD,
		author: AUTHOR,
		puts: following
			? [
					{
						collection: COLLECTIONS.threadFollow,
						rkey: "self",
						cid: "bafyreictestfollow",
						value: { $type: COLLECTIONS.threadFollow, createdAt: NOW },
					},
				]
			: [],
		deletes: following ? [] : [{ collection: COLLECTIONS.threadFollow, rkey: "self" }],
	});

	it("tells only the follower's own devices that they follow a thread", async () => {
		await database.db
			.insert(database.tables.threadFollows)
			.values({ space: THREAD, did: AUTHOR, createdAt: NOW });

		emit(followChange(true));
		await vi.waitFor(() => expect(framesOfType("threadEvent")).toHaveLength(1));

		const [entry] = framesOfType("threadEvent");
		expect(entry?.space).toBe(AUTHOR);
		expect(entry?.frame).toMatchObject({
			event: "update",
			community: COMMUNITY,
			channel: SPACE,
			thread: { space: THREAD, viewer: { following: true } },
		});
	});

	it("tells the follower's devices when they stop following", async () => {
		emit(followChange(false));
		await vi.waitFor(() => expect(framesOfType("threadEvent")).toHaveLength(1));

		expect(framesOfType("threadEvent")[0]?.frame).toMatchObject({
			thread: { space: THREAD, viewer: { following: false } },
		});
	});
});

describe("push updates for deleted and edited messages", () => {
	it("pushes a delete for a deleted message", async () => {
		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [],
			deletes: [{ collection: COLLECTIONS.message, rkey: "3lkmsgdeleted" }],
		});

		await vi.waitFor(() =>
			expect(pushed.deleted).toEqual([{ space: SPACE, author: AUTHOR, rkey: "3lkmsgdeleted" }]),
		);
	});

	it("pushes an edit with the new text for an updated message, and nothing for a new one", async () => {
		const edited = nextTid();
		const fresh = nextTid();
		await putMessageRow(edited, "fixed");
		await database.db
			.update(database.tables.messages)
			.set({ updatedAt: NOW })
			.where(eq(database.tables.messages.rkey, edited));
		await putMessageRow(fresh, "new");
		emit(messageChange(fresh));
		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.message,
					rkey: edited,
					cid: "bafyreictestedit",
					value: { $type: COLLECTIONS.message, text: "fixed", createdAt: NOW, updatedAt: NOW },
				},
			],
			deletes: [],
		});

		await vi.waitFor(() => expect(pushed.edited).toHaveLength(1));
		expect(pushed.edited[0]).toMatchObject({
			message: { space: SPACE, author: AUTHOR, rkey: edited, text: "fixed" },
		});
	});
	it("pushes an edit for a raw record edit that carries no updatedAt", async () => {
		const edited = nextTid();
		await putMessageRow(edited, "fixed by hand");
		await database.db
			.update(database.tables.messages)
			.set({ updatedAt: NOW })
			.where(eq(database.tables.messages.rkey, edited));
		emit({
			space: SPACE,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.message,
					rkey: edited,
					cid: "bafyreictestrawedit",
					value: { $type: COLLECTIONS.message, text: "fixed by hand", createdAt: NOW },
				},
			],
			deletes: [],
		});

		await vi.waitFor(() => expect(pushed.edited).toHaveLength(1));
		expect(pushed.edited[0]).toMatchObject({
			message: { space: SPACE, author: AUTHOR, rkey: edited, text: "fixed by hand" },
		});
	});
});

describe("closed threads", () => {
	const THREAD_SKEY = "3lkthreadclosed";
	const THREAD = threadSpace(COMMUNITY, THREAD_SKEY);
	const CLOSED_AT = "2026-08-23T01:00:00.000Z";
	const LATER = "2026-08-23T02:00:00.000Z";

	beforeEach(async () => {
		await database.db.insert(database.tables.members).values({
			community: COMMUNITY,
			did: AUTHOR,
			roles: [],
			joinedAt: NOW,
			nickname: null,
		});
		await database.db.insert(database.tables.threads).values({
			space: THREAD,
			community: COMMUNITY,
			channel: SPACE,
			skey: THREAD_SKEY,
			name: "release planning",
			createdBy: AUTHOR,
			createdAt: NOW,
			visibleToRoles: [],
			visibleToMembers: [],
			closedAt: CLOSED_AT,
			locked: true,
			lastActivityAt: NOW,
			indexedAt: NOW,
		});
	});

	const threadMessage = (createdAt: string, updatedAt?: string): RepoChange => ({
		space: THREAD,
		author: AUTHOR,
		puts: [
			{
				collection: COLLECTIONS.message,
				rkey: nextTid(),
				cid: "bafyreicthreadmsg",
				value: {
					$type: COLLECTIONS.message,
					text: "back again",
					createdAt,
					...(updatedAt ? { updatedAt } : {}),
				},
			},
		],
		deletes: [],
	});

	it("reopens a closed thread when someone posts in it and keeps the lock", async () => {
		emit(threadMessage(LATER));
		await vi.waitFor(() => expect(threadWrites).toHaveLength(1));

		const [write] = threadWrites;
		expect(write).toMatchObject({ community: COMMUNITY, space: THREAD });
		expect(write?.record.closedAt).toBeUndefined();
		expect(write?.record.locked).toBe(true);
		expect(write?.record.name).toBe("release planning");
	});

	it("leaves the thread closed for edits and for messages written before it closed", async () => {
		const before = threadMessage(NOW);
		const edit = threadMessage(NOW, LATER);
		const reopening = threadMessage(LATER);
		emit(before);
		emit(edit);
		emit(reopening);
		await vi.waitFor(() => expect(threadWrites).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(threadWrites).toHaveLength(1);
	});
	it("leaves the thread closed for a message dated in the future", async () => {
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		emit(threadMessage(future));
		emit(threadMessage(LATER));
		await vi.waitFor(() => expect(threadWrites).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(threadWrites).toHaveLength(1);
	});
});

describe("voice channel pushes", () => {
	const VOICE_SKEY = "3lkpipelinevoice";
	const VOICE = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, VOICE_SKEY);
	const LISTENER = "did:plc:listenerlistenerlistenerl";
	const ELSEWHERE = "did:plc:elsewhereelsewhereelsewh";

	beforeEach(async () => {
		await database.db.insert(database.tables.channels).values({
			space: VOICE,
			community: COMMUNITY,
			spaceType: SPACE_TYPES.channelVoice,
			skey: VOICE_SKEY,
			name: "lounge",
		});
		await database.db.insert(database.tables.members).values([
			{ community: COMMUNITY, did: AUTHOR, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: LISTENER, roles: [], joinedAt: NOW },
			{ community: COMMUNITY, did: ELSEWHERE, roles: [], joinedAt: NOW },
		]);
	});

	const mentionBoth = (space: string): RepoChange => ({
		space,
		author: AUTHOR,
		puts: [
			{
				collection: COLLECTIONS.message,
				rkey: nextTid(),
				cid: "bafyreicvoicemsg",
				value: {
					$type: COLLECTIONS.message,
					text: "ab",
					createdAt: NOW,
					facets: [
						mentionFacet(LISTENER),
						{ ...mentionFacet(ELSEWHERE), index: { byteStart: 1, byteEnd: 2 } },
					],
				},
			},
		],
		deletes: [],
	});

	it("pushes a voice channel message only to people connected to that channel", async () => {
		voicePresence.set(LISTENER, VOICE);
		voicePresence.set(
			ELSEWHERE,
			channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "3lkothervoice"),
		);

		emit(mentionBoth(VOICE));
		await vi.waitFor(() =>
			expect(
				framesOfType("notificationEvent")
					.map((entry) => entry.space)
					.sort(),
			).toEqual([ELSEWHERE, LISTENER].sort()),
		);
		await vi.waitFor(() => expect(pushed.notified).toEqual([LISTENER]));
	});

	it("pushes a voice channel edit only to people connected to that channel", async () => {
		const edited = nextTid();
		voicePresence.set(LISTENER, VOICE);
		await database.db.insert(database.tables.messages).values({
			space: VOICE,
			author: AUTHOR,
			rkey: edited,
			community: COMMUNITY,
			text: "after",
			createdAt: NOW,
			updatedAt: NOW,
			fromLegacyRepo: false,
			indexedAt: NOW,
		});
		emit({
			space: VOICE,
			author: AUTHOR,
			puts: [
				{
					collection: COLLECTIONS.message,
					rkey: edited,
					cid: "bafyreicvoiceedit",
					value: { $type: COLLECTIONS.message, text: "after", createdAt: NOW, updatedAt: NOW },
				},
			],
			deletes: [],
		});
		await vi.waitFor(() => expect(pushed.edited).toHaveLength(1));
		const { reaches } = pushed.edited[0] as { reaches?: (recipient: string) => boolean };
		expect(reaches?.(LISTENER)).toBe(true);
		expect(reaches?.(ELSEWHERE)).toBe(false);
	});

	it("pushes a text channel message to everyone it notifies, wherever they are connected", async () => {
		emit(mentionBoth(SPACE));
		await vi.waitFor(() =>
			expect([...pushed.notified].sort()).toEqual([ELSEWHERE, LISTENER].sort()),
		);
	});
});
