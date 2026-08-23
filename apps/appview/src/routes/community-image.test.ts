import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { CommunityLoader } from "@colibri-social/community";
import { COLLECTIONS, communitySpaces, SELF } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { ActorViews } from "../views/actor.js";
import { CommunityViews } from "../views/community.js";
import {
	handleDeleteCommunityImage,
	handlePutCommunityImage,
	handleUpdateCommunity,
} from "./community-write.js";

const NOW = "2026-08-23T00:00:00.000Z";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const OWNER = "did:plc:ownerxxxxxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

let database: TestDatabase;
let ctx: AppContext;
let writes: { record: Record<string, unknown> }[];
let uploads: { bytes: Uint8Array; mimeType: string }[];

const spaces = communitySpaces(COMMUNITY);

const setRecord = async (value: Record<string, unknown>) => {
	await database.db
		.insert(database.tables.records)
		.values({
			space: spaces.profile,
			author: COMMUNITY,
			collection: COLLECTIONS.community,
			rkey: SELF,
			cid: "bafyreicommunity",
			value,
			indexedAt: NOW,
		})
		.onConflictDoUpdate({
			target: [
				database.tables.records.space,
				database.tables.records.author,
				database.tables.records.collection,
				database.tables.records.rkey,
			],
			set: { value },
		});
};

beforeEach(async () => {
	database = await openTestDatabase();
	writes = [];
	uploads = [];

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		handle: null,
		name: "Test Community",
		description: "a place",
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		migratedFrom: null,
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});

	await database.db.insert(database.tables.roles).values({
		community: COMMUNITY,
		rkey: "3lkowner000000",
		name: "Owner",
		position: 100,
		permissions: ["community.manage"],
		channelOverrides: [],
		protected: true,
	});
	await database.db.insert(database.tables.members).values([
		{ community: COMMUNITY, did: OWNER, roles: ["3lkowner000000"], joinedAt: NOW },
		{ community: COMMUNITY, did: MEMBER, roles: [], joinedAt: NOW },
	]);

	const loader = new CommunityLoader({ db: database.db, tables: database.tables });
	ctx = {
		config: { PUBLIC_URL: "https://appview.test", APPVIEW_DID: "did:web:appview.test" },
		database,
		loader,
		identity: {
			resolveDid: async () => {
				throw new Error("no identity in tests");
			},
			resolveVerifiedHandle: async () => {
				throw new Error("no identity in tests");
			},
		},
		writer: {
			currentRecord: async () => {
				const [row] = await database.db
					.select({ value: database.tables.records.value })
					.from(database.tables.records);
				return row?.value ?? null;
			},
			uploadBlob: async (_community: string, bytes: Uint8Array, mimeType: string) => {
				uploads.push({ bytes, mimeType });
				return {
					$type: "blob" as const,
					ref: { $link: "bafkreiuploadedblob" },
					mimeType,
					size: bytes.byteLength,
				};
			},
			put: async (_community: string, write: { record: Record<string, unknown> }) => {
				writes.push({ record: write.record });
				await setRecord(write.record);
				return { uri: "at://x", rkey: SELF };
			},
		},
	} as unknown as AppContext;
});

afterEach(async () => {
	await database.destroy();
});

describe("community images", () => {
	it("uploads the bytes as the community and references the blob on the record", async () => {
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community" });

		const result = await handlePutCommunityImage(
			ctx,
			OWNER,
			{ community: COMMUNITY, kind: "picture" },
			PNG,
		);

		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.mimeType).toBe("image/png");
		expect(writes.at(-1)?.record.picture).toMatchObject({
			$type: "blob",
			ref: { $link: "bafkreiuploadedblob" },
			mimeType: "image/png",
		});
		expect(result.community.picture).toContain("cid=bafkreiuploadedblob");
		expect(result.community.picture).toContain("variant=avatar");
	});

	it("refuses a member without community.manage", async () => {
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community" });
		await expect(
			handlePutCommunityImage(ctx, MEMBER, { community: COMMUNITY, kind: "picture" }, PNG),
		).rejects.toThrow(/community\.manage/);
		expect(uploads).toHaveLength(0);
	});

	it("refuses bytes that are not an accepted image", async () => {
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community" });
		const notAnImage = new TextEncoder().encode("this is definitely not a png");
		await expect(
			handlePutCommunityImage(ctx, OWNER, { community: COMMUNITY, kind: "banner" }, notAnImage),
		).rejects.toThrow(/UnsupportedImage|not an accepted/);
		expect(uploads).toHaveLength(0);
	});

	it("refuses an image over the size cap for its kind", async () => {
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community" });
		const tooBig = new Uint8Array(1024 * 1024 + 1);
		tooBig.set(PNG, 0);
		await expect(
			handlePutCommunityImage(ctx, OWNER, { community: COMMUNITY, kind: "picture" }, tooBig),
		).rejects.toThrow(/exceed/);
		expect(uploads).toHaveLength(0);
	});

	it("accepts a streamed body and caps it while streaming", async () => {
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community" });
		const stream = (async function* () {
			yield PNG.slice(0, 20);
			yield PNG.slice(20);
		})();

		await handlePutCommunityImage(ctx, OWNER, { community: COMMUNITY, kind: "banner" }, stream);
		expect(uploads[0]?.bytes.byteLength).toBe(PNG.byteLength);
	});

	it("clears an image, and clearing one that was never set still succeeds", async () => {
		await setRecord({
			$type: COLLECTIONS.community,
			name: "Test Community",
			picture: { $type: "blob", ref: { $link: "bafkreiold" }, mimeType: "image/png", size: 10 },
		});

		const cleared = await handleDeleteCommunityImage(ctx, OWNER, {
			community: COMMUNITY,
			kind: "picture",
		});
		expect(writes.at(-1)?.record.picture).toBeUndefined();
		expect(cleared.community.picture).toBeUndefined();

		const again = await handleDeleteCommunityImage(ctx, OWNER, {
			community: COMMUNITY,
			kind: "banner",
		});
		expect(again.community.banner).toBeUndefined();
	});

	it("keeps the picture and banner when the community is renamed", async () => {
		const picture = {
			$type: "blob",
			ref: { $link: "bafkreipicture" },
			mimeType: "image/png",
			size: 10,
		};
		const banner = {
			$type: "blob",
			ref: { $link: "bafkreibanner" },
			mimeType: "image/png",
			size: 20,
		};
		await setRecord({ $type: COLLECTIONS.community, name: "Test Community", picture, banner });

		const communities = new CommunityViews(ctx, new ActorViews(ctx));
		await handleUpdateCommunity(ctx, communities, OWNER, {
			community: COMMUNITY,
			name: "Renamed",
		});

		const record = writes.filter((w) => w.record.$type === COLLECTIONS.community).at(-1)?.record;
		expect(record?.name).toBe("Renamed");
		expect(record?.picture).toEqual(picture);
		expect(record?.banner).toEqual(banner);
	});
});
