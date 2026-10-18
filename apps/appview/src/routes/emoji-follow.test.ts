import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter } from "@colibri-social/community";
import { BLUEMOJI } from "@colibri-social/emoji";
import { communitySpaces } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import {
	handleCreatePack,
	handleDeletePack,
	handleGetLibrary,
	handlePutFollow,
	handleUpdatePack,
	handleUploadEmoji,
} from "./emoji.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const FOLLOWER = "did:plc:follower";
const BYSTANDER = "did:plc:bystander";
const GONE = "did:plc:gone";
const NOW = "2026-10-18T00:00:00.000Z";
const BLOB = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

let database: TestDatabase;
let ctx: AppContext;
let writer: CommunityWriter;
let userFrames: Array<{ did: string; frame: Record<string, unknown> }>;

const fakeWriter = (): CommunityWriter =>
	({
		spaces: (community: string) => communitySpaces(community),
		uploadBlob: async (_community: string, bytes: Uint8Array, mimeType: string) => ({
			$type: "blob" as const,
			ref: { $link: BLOB },
			mimeType,
			size: bytes.byteLength,
		}),
		putPublic: async (
			community: string,
			write: { collection: string; rkey: string; record: Record<string, unknown> },
		) => ({ uri: `at://${community}/${write.collection}/${write.rkey}`, cid: "cid" }),
		removePublic: async () => {},
	}) as unknown as CommunityWriter;

const upload = (name: string) =>
	handleUploadEmoji(ctx, writer, OWNER, { community: COMMUNITY, name }, PNG);

const library = async (did = FOLLOWER) => (await handleGetLibrary(ctx, did)).library;

const framesFor = (did: string) =>
	userFrames
		.filter((entry) => entry.did === did)
		.map((entry) => entry.frame as { $type: string; library: Awaited<ReturnType<typeof library>> });

beforeEach(async () => {
	database = await openTestDatabase();
	userFrames = [];
	writer = fakeWriter();
	ctx = {
		announce: {
			...silentAnnouncer,
			toUser: (did: string, frame: Record<string, unknown>) => userFrames.push({ did, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
		database,
		identity: {
			resolveDid: async () => {
				throw new Error("the account is gone");
			},
		},
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
	} as unknown as AppContext;

	const spaces = communitySpaces(COMMUNITY);
	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Birds",
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});
	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey: "owner",
		name: "owner",
		color: null,
		permissions: ["community.manage"],
		position: 1000,
		hoisted: false,
		mentionable: false,
		protected: true,
		channelOverrides: [],
	});
	await database.db
		.insert(database.tables.members)
		.values({ community: COMMUNITY, did: OWNER, roles: ["owner"], joinedAt: NOW, nickname: null });
	await database.db.insert(database.tables.emojiBackfills).values([
		{ owner: COMMUNITY, completedAt: NOW },
		{ owner: FOLLOWER, completedAt: NOW },
	]);
});

afterEach(async () => {
	await database.destroy();
});

describe("following a pack", () => {
	it("resolves the pack with its emoji in pack order and its owner", async () => {
		const wave = (await upload("wave")).emoji;
		const owl = (await upload("owl")).emoji;
		const { pack } = await handleCreatePack(ctx, writer, OWNER, {
			community: COMMUNITY,
			name: "Birds",
			emojis: [owl.uri, wave.uri],
		});

		const { follow } = await handlePutFollow(ctx, FOLLOWER, {
			rkey: "3kfollow1",
			subject: pack.uri,
			createdAt: NOW,
		});

		expect(follow).toMatchObject({
			uri: `at://${FOLLOWER}/social.colibri.beta.emoji.follow/3kfollow1`,
			subject: pack.uri,
			kind: "pack",
			state: "available",
			owner: { did: COMMUNITY, kind: "community", displayName: "Birds" },
			pack: { uri: pack.uri, name: "Birds" },
		});
		expect(follow?.emojis.map((emoji) => emoji.name)).toEqual(["owl", "wave"]);
		expect(framesFor(FOLLOWER).map((frame) => frame.$type)).toEqual([
			"social.colibri.beta.sync.defs#emojiLibraryEvent",
		]);
	});

	it("reflects members the owner adds and removes, and only tells followers", async () => {
		const wave = (await upload("wave")).emoji;
		const owl = (await upload("owl")).emoji;
		const { pack } = await handleCreatePack(ctx, writer, OWNER, {
			community: COMMUNITY,
			name: "Birds",
			emojis: [wave.uri],
		});
		await handlePutFollow(ctx, FOLLOWER, { rkey: "3kfollow1", subject: pack.uri });
		userFrames = [];

		await handleUpdatePack(ctx, writer, OWNER, {
			community: COMMUNITY,
			pack: pack.uri,
			emojis: [wave.uri, owl.uri],
		});
		const added = framesFor(FOLLOWER).at(-1)?.library.follows[0];
		expect(added?.emojis.map((emoji) => emoji.name)).toEqual(["wave", "owl"]);

		await handleUpdatePack(ctx, writer, OWNER, {
			community: COMMUNITY,
			pack: pack.uri,
			emojis: [owl.uri],
		});
		const removed = framesFor(FOLLOWER).at(-1)?.library.follows[0];
		expect(removed?.emojis.map((emoji) => emoji.name)).toEqual(["owl"]);
		expect(framesFor(BYSTANDER)).toEqual([]);
		expect(userFrames.every((entry) => entry.did === FOLLOWER)).toBe(true);
	});

	it("marks a deleted pack as missing and keeps the follow", async () => {
		const wave = (await upload("wave")).emoji;
		const { pack } = await handleCreatePack(ctx, writer, OWNER, {
			community: COMMUNITY,
			name: "Birds",
			emojis: [wave.uri],
		});
		await handlePutFollow(ctx, FOLLOWER, { rkey: "3kfollow1", subject: pack.uri });

		await handleDeletePack(ctx, writer, OWNER, { community: COMMUNITY, pack: pack.uri });

		const [follow] = (await library()).follows;
		expect(follow).toMatchObject({ subject: pack.uri, state: "missing", emojis: [] });
		expect(follow?.pack).toBeUndefined();
	});
});

describe("following a single emoji", () => {
	it("resolves the emoji and unfollows when the subject is absent", async () => {
		const wave = (await upload("wave")).emoji;
		const { follow } = await handlePutFollow(ctx, FOLLOWER, {
			rkey: "3kfollow1",
			subject: wave.uri,
		});
		expect(follow).toMatchObject({ kind: "emoji", state: "available" });
		expect(follow?.emojis.map((emoji) => emoji.uri)).toEqual([wave.uri]);

		expect(await handlePutFollow(ctx, FOLLOWER, { rkey: "3kfollow1" })).toEqual({});
		expect((await library()).follows).toEqual([]);
		expect(framesFor(FOLLOWER).at(-1)?.library.follows).toEqual([]);
	});

	it("moves an existing follow of the same subject to the new record key", async () => {
		const wave = (await upload("wave")).emoji;
		await handlePutFollow(ctx, FOLLOWER, { rkey: "3kfollow1", subject: wave.uri });
		await handlePutFollow(ctx, FOLLOWER, { rkey: "3kfollow2", subject: wave.uri });

		const follows = (await library()).follows;
		expect(follows.map((entry) => entry.uri)).toEqual([
			`at://${FOLLOWER}/social.colibri.beta.emoji.follow/3kfollow2`,
		]);
	});
});

describe("subject validation", () => {
	it("refuses the caller's own emoji", async () => {
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${FOLLOWER}/${BLUEMOJI.item}/wave`,
			}),
		).rejects.toMatchObject({ customErrorName: "OwnEmoji" });
	});

	it("refuses collections no provider owns, and pack memberships", async () => {
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${COMMUNITY}/app.bsky.feed.post/3kpost`,
			}),
		).rejects.toMatchObject({ customErrorName: "UnsupportedProvider" });
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${COMMUNITY}/${BLUEMOJI.membership}/3kmember`,
			}),
		).rejects.toMatchObject({ customErrorName: "UnsupportedProvider" });
	});

	it("refuses subjects that don't exist", async () => {
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${COMMUNITY}/${BLUEMOJI.item}/nope`,
			}),
		).rejects.toMatchObject({ customErrorName: "EmojiNotFound" });
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${COMMUNITY}/${BLUEMOJI.pack}/nope`,
			}),
		).rejects.toMatchObject({ customErrorName: "PackNotFound" });
		expect((await library()).follows).toEqual([]);
	});

	it("reports an owner whose repo can't be read", async () => {
		await expect(
			handlePutFollow(ctx, FOLLOWER, {
				rkey: "3kfollow1",
				subject: `at://${GONE}/${BLUEMOJI.pack}/3kpack`,
			}),
		).rejects.toMatchObject({ customErrorName: "UpstreamFailure" });
	});
});

describe("the library", () => {
	it("lists the caller's own catalog and marks unreachable owners", async () => {
		await database.db.insert(database.tables.emojiFollows).values({
			follower: FOLLOWER,
			rkey: "3kfollow1",
			subject: `at://${GONE}/${BLUEMOJI.pack}/3kpack`,
			subjectOwner: GONE,
			createdAt: NOW,
		});

		const result = await library();
		expect(result.own).toEqual({ owner: FOLLOWER, emojis: [], packs: [] });
		expect(result.follows).toEqual([
			expect.objectContaining({
				subject: `at://${GONE}/${BLUEMOJI.pack}/3kpack`,
				kind: "pack",
				state: "unreachable",
				owner: expect.objectContaining({ did: GONE, kind: "user" }),
				emojis: [],
			}),
		]);
	});

	it("orders follows oldest first", async () => {
		const wave = (await upload("wave")).emoji;
		const owl = (await upload("owl")).emoji;
		await handlePutFollow(ctx, FOLLOWER, {
			rkey: "3kfollow2",
			subject: owl.uri,
			createdAt: "2026-10-18T02:00:00.000Z",
		});
		await handlePutFollow(ctx, FOLLOWER, {
			rkey: "3kfollow1",
			subject: wave.uri,
			createdAt: "2026-10-18T01:00:00.000Z",
		});

		expect((await library()).follows.map((entry) => entry.subject)).toEqual([wave.uri, owl.uri]);
	});
});
