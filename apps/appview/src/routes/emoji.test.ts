import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader, type CommunityWriter } from "@colibri-social/community";
import {
	BLUEMOJI,
	bluemojiProvider,
	createEmojiRegistry,
	type EmojiProvider,
} from "@colibri-social/emoji";
import { communitySpaces } from "@colibri-social/lexicons";
import type { PdsClient } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentAnnouncer } from "../announce.js";
import type { AppContext } from "../context.js";
import { backfillEmoji, loadCatalog } from "../emoji.js";
import {
	handleCreatePack,
	handleDeleteEmoji,
	handleDeletePack,
	handleGetCatalog,
	handleGetEmojis,
	handleRenameEmoji,
	handleUpdatePack,
	handleUploadEmoji,
} from "./emoji.js";

const COMMUNITY = "did:plc:community";
const OWNER = "did:plc:owner";
const MEMBER = "did:plc:member";
const NOW = "2026-10-18T00:00:00.000Z";
const BLOB = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const ITEM_ONLY = "test.items";
const itemOnly: EmojiProvider = {
	id: ITEM_ONLY,
	collections: { item: "test.items.emoji" },
	maxImageBytes: 1000,
	imageTypes: new Set(["image/png"]),
	parseItem: (value) =>
		typeof value === "object" && value !== null && "label" in value
			? {
					name: String((value as { label: unknown }).label),
					images: [{ cid: BLOB, format: "png", animated: false }],
					createdAt: NOW,
				}
			: null,
	buildItem: ({ name, newKey }) => ({
		collection: "test.items.emoji",
		rkey: newKey(),
		record: { label: name },
	}),
	renameItem: ({ rkey, record, name }) => ({
		collection: "test.items.emoji",
		rkey,
		record: { ...record, label: name },
	}),
};

const registry = createEmojiRegistry([bluemojiProvider, itemOnly], BLUEMOJI.provider);

let database: TestDatabase;
let ctx: AppContext;
let writer: CommunityWriter;
let puts: Array<{ collection: string; rkey: string; record: Record<string, unknown> }>;
let removals: Array<{ collection: string; rkey: string }>;
let announced: Array<{ community: string; frame: Record<string, unknown> }>;

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
		) => {
			puts.push(write);
			return {
				uri: `at://${community}/${write.collection}/${write.rkey}`,
				cid: `cid-${puts.length}`,
			};
		},
		removePublic: async (_community: string, params: { collection: string; rkey: string }) => {
			removals.push(params);
		},
	}) as unknown as CommunityWriter;

const addCommunity = () => {
	const spaces = communitySpaces(COMMUNITY);
	return database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		name: "Test",
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});
};

const upload = (name: string, extra: { pack?: string; provider?: string } = {}) =>
	handleUploadEmoji(ctx, writer, OWNER, { community: COMMUNITY, name, ...extra }, PNG, registry);

beforeEach(async () => {
	database = await openTestDatabase();
	puts = [];
	removals = [];
	announced = [];
	writer = fakeWriter();

	ctx = {
		announce: {
			...silentAnnouncer,
			toCommunity: (community: string, frame: Record<string, unknown>) =>
				announced.push({ community, frame }),
		},
		database,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
	} as unknown as AppContext;

	await addCommunity();
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
	await database.db.insert(database.tables.members).values([
		{ community: COMMUNITY, did: OWNER, roles: ["owner"], joinedAt: NOW, nickname: null },
		{ community: COMMUNITY, did: MEMBER, roles: [], joinedAt: NOW, nickname: null },
	]);
	await database.db
		.insert(database.tables.emojiBackfills)
		.values({ owner: COMMUNITY, completedAt: NOW });
});

afterEach(async () => {
	await database.destroy();
});

describe("uploading", () => {
	it("writes a bluemoji record to the community's repo and announces the catalog", async () => {
		const { emoji } = await upload("wave");

		expect(emoji).toMatchObject({
			uri: `at://${COMMUNITY}/${BLUEMOJI.item}/wave`,
			provider: BLUEMOJI.provider,
			owner: COMMUNITY,
			name: "wave",
		});
		expect(emoji.images[0]).toMatchObject({ cid: BLOB, format: "png", mimeType: "image/png" });
		expect(puts.map((write) => [write.collection, write.rkey])).toEqual([[BLUEMOJI.item, "wave"]]);
		expect(announced).toHaveLength(1);
		expect(announced[0]?.frame).toMatchObject({
			$type: "social.colibri.beta.sync.defs#emojiEvent",
			owner: COMMUNITY,
		});
	});

	it("refuses members without community.manage", async () => {
		await expect(
			handleUploadEmoji(ctx, writer, MEMBER, { community: COMMUNITY, name: "wave" }, PNG, registry),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		expect(puts).toEqual([]);
	});

	it("refuses invalid and taken names", async () => {
		await expect(upload("Wave!")).rejects.toMatchObject({ customErrorName: "InvalidName" });
		await upload("wave");
		await expect(upload("wave")).rejects.toMatchObject({ customErrorName: "NameTaken" });
	});

	it("refuses bytes that are not an image", async () => {
		await expect(
			handleUploadEmoji(
				ctx,
				writer,
				OWNER,
				{ community: COMMUNITY, name: "wave" },
				new Uint8Array([1, 2, 3, 4]),
				registry,
			),
		).rejects.toMatchObject({ customErrorName: "UnsupportedImage" });
	});

	it("refuses an image above the provider's limit", async () => {
		const large = new Uint8Array(bluemojiProvider.maxImageBytes + 1);
		large.set(PNG);
		await expect(
			handleUploadEmoji(
				ctx,
				writer,
				OWNER,
				{ community: COMMUNITY, name: "wave" },
				large,
				registry,
			),
		).rejects.toMatchObject({ customErrorName: "ImageTooLarge" });
	});

	it("refuses an unknown provider", async () => {
		await expect(upload("wave", { provider: "nope" })).rejects.toMatchObject({
			customErrorName: "UnsupportedProvider",
		});
	});

	it("writes through a second provider", async () => {
		const { emoji } = await upload("wave", { provider: ITEM_ONLY });
		expect(emoji).toMatchObject({ provider: ITEM_ONLY, name: "wave" });
		expect(puts[0]?.collection).toBe("test.items.emoji");
	});

	it("adds the emoji to a pack", async () => {
		const { pack } = await handleCreatePack(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, name: "Waves", emojis: [] },
			registry,
		);
		await upload("wave", { pack: pack.uri });

		const catalog = await loadCatalog(ctx, COMMUNITY, registry);
		expect(catalog.packs[0]?.emojis).toEqual([`at://${COMMUNITY}/${BLUEMOJI.item}/wave`]);
	});
});

describe("renaming", () => {
	it("moves the record to the new key and repoints pack memberships", async () => {
		const { emoji } = await upload("wave");
		const { pack } = await handleCreatePack(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, name: "Waves", emojis: [emoji.uri] },
			registry,
		);

		const renamed = await handleRenameEmoji(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, emoji: emoji.uri, name: "hello" },
			registry,
		);

		expect(renamed.emoji.uri).toBe(`at://${COMMUNITY}/${BLUEMOJI.item}/hello`);
		expect(removals).toContainEqual({ collection: BLUEMOJI.item, rkey: "wave" });
		const catalog = await loadCatalog(ctx, COMMUNITY, registry);
		expect(catalog.emojis.map((entry) => entry.name)).toEqual(["hello"]);
		expect(catalog.packs.find((entry) => entry.uri === pack.uri)?.emojis).toEqual([
			renamed.emoji.uri,
		]);
	});

	it("rewrites in place for a provider that does not key by name", async () => {
		const { emoji } = await upload("wave", { provider: ITEM_ONLY });
		const renamed = await handleRenameEmoji(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, emoji: emoji.uri, name: "hello" },
			registry,
		);
		expect(renamed.emoji.uri).toBe(emoji.uri);
		expect(renamed.emoji.name).toBe("hello");
		expect(removals).toEqual([]);
	});

	it("refuses an emoji of another repo", async () => {
		await expect(
			handleRenameEmoji(
				ctx,
				writer,
				OWNER,
				{ community: COMMUNITY, emoji: `at://${OWNER}/${BLUEMOJI.item}/wave`, name: "hello" },
				registry,
			),
		).rejects.toMatchObject({ customErrorName: "EmojiNotFound" });
	});
});

describe("deleting", () => {
	it("removes the emoji and its pack memberships", async () => {
		const { emoji } = await upload("wave");
		await handleCreatePack(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, name: "Waves", emojis: [emoji.uri] },
			registry,
		);

		await handleDeleteEmoji(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, emoji: emoji.uri },
			registry,
		);

		const catalog = await loadCatalog(ctx, COMMUNITY, registry);
		expect(catalog.emojis).toEqual([]);
		expect(catalog.packs[0]?.emojis).toEqual([]);
		expect(removals.map((entry) => entry.collection)).toEqual([BLUEMOJI.membership, BLUEMOJI.item]);
	});
});

describe("packs", () => {
	it("refuses packs for a provider without them", async () => {
		await expect(
			handleCreatePack(
				ctx,
				writer,
				OWNER,
				{ community: COMMUNITY, name: "Waves", emojis: [], provider: ITEM_ONLY },
				registry,
			),
		).rejects.toMatchObject({ customErrorName: "UnsupportedProvider" });
	});

	it("refuses emoji that are not the community's", async () => {
		await expect(
			handleCreatePack(
				ctx,
				writer,
				OWNER,
				{
					community: COMMUNITY,
					name: "Waves",
					emojis: [`at://${COMMUNITY}/${BLUEMOJI.item}/ghost`],
				},
				registry,
			),
		).rejects.toMatchObject({ customErrorName: "EmojiNotFound" });
	});

	it("renames a pack and replaces its emoji in order", async () => {
		const wave = (await upload("wave")).emoji;
		const hello = (await upload("hello")).emoji;
		const { pack } = await handleCreatePack(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, name: "Waves", description: "hands", emojis: [wave.uri] },
			registry,
		);

		const updated = await handleUpdatePack(
			ctx,
			writer,
			OWNER,
			{
				community: COMMUNITY,
				pack: pack.uri,
				name: "Greetings",
				description: "",
				emojis: [hello.uri, wave.uri],
			},
			registry,
		);

		expect(updated.pack).toMatchObject({ name: "Greetings", emojis: [hello.uri, wave.uri] });
		expect(updated.pack.description).toBeUndefined();
	});

	it("deletes a pack and keeps its emoji", async () => {
		const wave = (await upload("wave")).emoji;
		const { pack } = await handleCreatePack(
			ctx,
			writer,
			OWNER,
			{ community: COMMUNITY, name: "Waves", emojis: [wave.uri] },
			registry,
		);

		await handleDeletePack(ctx, writer, OWNER, { community: COMMUNITY, pack: pack.uri }, registry);

		const catalog = await loadCatalog(ctx, COMMUNITY, registry);
		expect(catalog.packs).toEqual([]);
		expect(catalog.emojis.map((entry) => entry.uri)).toEqual([wave.uri]);
	});
});

describe("the catalog", () => {
	it("backfills a repo from its PDS once, across every provider", async () => {
		const USER = "did:plc:user";
		const listed: string[] = [];
		const client = {
			listPublicRecords: async (_repo: string, collection: string) => {
				listed.push(collection);
				if (collection === BLUEMOJI.item) {
					return {
						records: [
							{
								uri: `at://${USER}/${BLUEMOJI.item}/wave`,
								cid: "cid-wave",
								value: {
									name: ":wave:",
									createdAt: NOW,
									formats: { png_128: { ref: { $link: BLOB }, mimeType: "image/png", size: 1 } },
								},
							},
						],
					};
				}
				if (collection === "test.items.emoji") {
					return {
						records: [
							{ uri: `at://${USER}/test.items.emoji/3abc`, cid: "cid-x", value: { label: "x" } },
						],
					};
				}
				return { records: [] };
			},
		} as unknown as PdsClient;

		await backfillEmoji(ctx, USER, registry, client);
		const { catalog } = await handleGetCatalog(ctx, USER, registry);

		expect(listed).toEqual(registry.collections);
		expect(catalog.emojis.map((entry) => [entry.provider, entry.name])).toEqual([
			[BLUEMOJI.provider, "wave"],
			[ITEM_ONLY, "x"],
		]);
	});
});

describe("batch lookup", () => {
	it("returns emoji from several repos in request order and skips unknown URIs", async () => {
		const USER = "did:plc:user";
		const client = {
			listPublicRecords: async (_repo: string, collection: string) =>
				collection === BLUEMOJI.item
					? {
							records: [
								{
									uri: `at://${USER}/${BLUEMOJI.item}/badger`,
									cid: "cid-badger",
									value: {
										name: ":badger:",
										createdAt: NOW,
										formats: {
											png_128: { ref: { $link: BLOB }, mimeType: "image/png", size: 1 },
										},
									},
								},
							],
						}
					: { records: [] },
		} as unknown as PdsClient;
		await backfillEmoji(ctx, USER, registry, client);
		const { emoji: wave } = await upload("wave");
		const { emoji: other } = await upload("other", { provider: ITEM_ONLY });
		const badger = `at://${USER}/${BLUEMOJI.item}/badger`;

		const result = await handleGetEmojis(
			ctx,
			[
				badger,
				`at://${COMMUNITY}/${BLUEMOJI.item}/missing`,
				wave.uri,
				`at://${COMMUNITY}/${BLUEMOJI.pack}/wave`,
				"not a uri",
				other.uri,
				badger,
			],
			registry,
		);

		expect(result.emojis.map((entry) => entry.uri)).toEqual([badger, wave.uri, other.uri]);
		expect(result.emojis[0]).toMatchObject({ owner: USER, name: "badger", cid: "cid-badger" });
		expect(result.unreachable).toBeUndefined();
	});

	it("reports owners whose repo cannot be read and still returns the rest", async () => {
		const warnings: unknown[] = [];
		ctx = {
			...ctx,
			log: { warn: (detail: unknown) => warnings.push(detail) },
			identity: {
				resolveDid: async () => {
					throw new Error("plc unavailable");
				},
			},
		} as unknown as AppContext;
		const { emoji: wave } = await upload("wave");
		const STRANGER = "did:plc:stranger";

		const result = await handleGetEmojis(
			ctx,
			[`at://${STRANGER}/${BLUEMOJI.item}/hello`, wave.uri],
			registry,
		);

		expect(result.emojis.map((entry) => entry.uri)).toEqual([wave.uri]);
		expect(result.unreachable).toEqual([STRANGER]);
		expect(warnings).toEqual([expect.objectContaining({ owner: STRANGER })]);
	});
});
