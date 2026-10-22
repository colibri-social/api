import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import type { LinkEmbed } from "@colibri-social/embeds";
import { channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { republishWhenPreviewsSettle } from "./embed-republish.js";
import { ActorViews } from "./views/actor.js";
import { ChannelViews } from "./views/channel.js";
import type { ChannelFrame } from "./ws/events.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkaaaa";
const VIEWER = "did:plc:viewerviewerviewerviewer";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "3lkrepublishtest");
const NOW = "2026-08-23T00:00:00.000Z";
const URI = "https://example.test/article";

let database: TestDatabase;
let ctx: AppContext;
let channels: ChannelViews;
let previews: Map<string, LinkEmbed>;
let release: () => void;
let published: { space: string; frame: ChannelFrame }[];

const publish = (space: string, frame: ChannelFrame) => published.push({ space, frame });

beforeEach(async () => {
	database = await openTestDatabase();
	previews = new Map();
	published = [];
	const settled = new Promise<void>((resolve) => {
		release = resolve;
	});
	ctx = {
		database,
		log: { error: () => {} },
		config: { PUBLIC_URL: "https://appview.test" },
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		linkEmbeds: {
			peek: (uri: string) => previews.get(uri),
			resolve: async (uris: readonly string[]) =>
				new Map(uris.flatMap((uri) => (previews.get(uri) ? [[uri, previews.get(uri)]] : []))),
			settle: () => settled,
		},
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandles: async () => new Map(),
		},
	} as unknown as AppContext;
	channels = new ChannelViews(ctx, new ActorViews(ctx));
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
});

afterEach(async () => {
	await database.destroy();
});

const putLinkMessage = async () => {
	const rkey = nextTid();
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: URI,
		facets: [
			{
				index: { byteStart: 0, byteEnd: URI.length },
				features: [{ $type: "social.colibri.beta.richtext.facet#link", uri: URI }],
			},
		],
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
	});
	return rkey;
};

describe("republishWhenPreviewsSettle", () => {
	it("publishes the message once its preview resolves, once per message", async () => {
		const rkey = await putLinkMessage();
		const target = { space: SPACE, readingSpace: SPACE, author: AUTHOR, rkey };

		republishWhenPreviewsSettle(ctx, channels, publish, target, [URI]);
		republishWhenPreviewsSettle(ctx, channels, publish, target, [URI]);
		previews.set(URI, { uri: URI, title: "An article" });
		release();

		await vi.waitFor(() => expect(published).toHaveLength(1));
		const entry = published[0] as { space: string; frame: ChannelFrame };
		const frame = (entry.frame as (viewer: string) => Record<string, unknown>)(VIEWER);
		expect(entry.space).toBe(SPACE);
		expect(frame).toMatchObject({
			event: "update",
			channel: SPACE,
			message: { rkey, embeds: [expect.objectContaining({ title: "An article" })] },
		});
		expect((frame.message as { updatedAt?: string }).updatedAt).toBeUndefined();
	});

	it("stays quiet when the preview never resolves", async () => {
		const rkey = await putLinkMessage();

		republishWhenPreviewsSettle(
			ctx,
			channels,
			publish,
			{ space: SPACE, readingSpace: SPACE, author: AUTHOR, rkey },
			[URI],
		);
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(published).toEqual([]);
	});
});
