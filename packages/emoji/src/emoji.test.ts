import { describe, expect, it } from "vitest";
import {
	BLUEMOJI,
	bluemojiProvider,
	createEmojiRegistry,
	type EmojiProvider,
	emojiRegistry,
	supportsPacks,
} from "./index.js";

const BLOB = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiibsojllbf5xhqzy6a";
const image = { $type: "blob" as const, ref: { $link: BLOB }, mimeType: "image/webp", size: 42 };

const itemOnly: EmojiProvider = {
	id: "test.items",
	collections: { item: "test.items.emoji" },
	maxImageBytes: 1000,
	imageTypes: new Set(["image/png"]),
	parseItem: (value) =>
		typeof value === "object" && value !== null && "label" in value
			? {
					name: String((value as { label: unknown }).label),
					images: [{ cid: BLOB, format: "png", animated: false }],
					createdAt: "2026-10-18T00:00:00.000Z",
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

describe("bluemoji", () => {
	it("writes a formats_v1 item keyed by its name", () => {
		const write = bluemojiProvider.buildItem({
			name: "wave",
			image,
			createdAt: "2026-10-18T00:00:00.000Z",
			newKey: () => "unused",
		});
		expect(write).toEqual({
			collection: BLUEMOJI.item,
			rkey: "wave",
			record: {
				$type: BLUEMOJI.item,
				name: ":wave:",
				createdAt: "2026-10-18T00:00:00.000Z",
				formats: { $type: BLUEMOJI.formatsV1, original: image, webp_128: image },
			},
		});
	});

	it("reads back what it writes", () => {
		const { record } = bluemojiProvider.buildItem({
			name: "wave",
			image,
			createdAt: "2026-10-18T00:00:00.000Z",
			newKey: () => "unused",
		});
		expect(bluemojiProvider.parseItem(record)).toEqual({
			name: "wave",
			createdAt: "2026-10-18T00:00:00.000Z",
			images: [
				{
					cid: BLOB,
					format: "webp",
					animated: false,
					mimeType: "image/webp",
					size: 42,
					pixels: 128,
				},
			],
		});
	});

	it("falls back to the original when no sized format exists", () => {
		const parsed = bluemojiProvider.parseItem({
			name: ":odd:",
			createdAt: "2026-10-18T00:00:00.000Z",
			formats: { original: { ...image, mimeType: "image/svg+xml" } },
		});
		expect(parsed?.images).toEqual([
			{ cid: BLOB, format: "other", animated: false, mimeType: "image/svg+xml", size: 42 },
		]);
	});

	it("rejects records without an image", () => {
		expect(
			bluemojiProvider.parseItem({ name: ":x:", createdAt: "2026-10-18", formats: {} }),
		).toBeNull();
		expect(bluemojiProvider.parseItem("nope")).toBeNull();
	});

	it("moves a renamed item to the new name's key and keeps its other fields", () => {
		const renamed = bluemojiProvider.renameItem({
			rkey: "wave",
			record: { $type: BLUEMOJI.item, name: ":wave:", alt: "a hand", formats: {} },
			name: "hello",
		});
		expect(renamed).toEqual({
			collection: BLUEMOJI.item,
			rkey: "hello",
			record: { $type: BLUEMOJI.item, name: ":hello:", alt: "a hand", formats: {} },
		});
	});

	it("supports packs", () => {
		expect(supportsPacks(bluemojiProvider)).toBe(true);
	});
});

describe("registry", () => {
	it("routes every collection to its provider", () => {
		const registry = createEmojiRegistry([bluemojiProvider, itemOnly], BLUEMOJI.provider);
		expect(registry.collections).toEqual([
			BLUEMOJI.item,
			BLUEMOJI.pack,
			BLUEMOJI.membership,
			"test.items.emoji",
		]);
		expect(registry.forCollection(BLUEMOJI.membership)).toEqual({
			provider: bluemojiProvider,
			kind: "membership",
		});
		expect(registry.forCollection("test.items.emoji")).toEqual({
			provider: itemOnly,
			kind: "item",
		});
		expect(registry.forCollection("app.bsky.feed.post")).toBeUndefined();
	});

	it("treats a provider without pack collections as pack-less", () => {
		expect(supportsPacks(itemOnly)).toBe(false);
	});

	it("refuses a default that is not registered", () => {
		expect(() => createEmojiRegistry([itemOnly], BLUEMOJI.provider)).toThrow();
	});

	it("defaults to bluemoji", () => {
		expect(emojiRegistry.defaultProvider.id).toBe(BLUEMOJI.provider);
	});
});
