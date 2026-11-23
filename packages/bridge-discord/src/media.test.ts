import { describe, expect, it } from "vitest";
import {
	attachmentPayload,
	embedColor,
	MAX_DISCORD_EMBEDS,
	previewEmbeds,
	remoteAttachment,
} from "./media.js";

const discordAttachment = {
	url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
	name: "cat.png",
	size: 1024,
	description: null,
	spoiler: false,
};

describe("remoteAttachment", () => {
	it("keeps a plain attachment as it is", () => {
		expect(remoteAttachment(discordAttachment)).toEqual({
			url: discordAttachment.url,
			name: "cat.png",
			size: 1024,
		});
	});

	it("carries the description over as alt text", () => {
		expect(remoteAttachment({ ...discordAttachment, description: "A sleeping cat" })).toMatchObject(
			{ alt: "A sleeping cat" },
		);
	});

	it("marks a SPOILER_ file as a spoiler and drops the prefix from its name", () => {
		expect(remoteAttachment({ ...discordAttachment, name: "SPOILER_cat.png" })).toMatchObject({
			name: "cat.png",
			spoiler: true,
		});
	});

	it("marks an attachment flagged as a spoiler", () => {
		expect(remoteAttachment({ ...discordAttachment, spoiler: true })).toMatchObject({
			name: "cat.png",
			spoiler: true,
		});
	});
});

describe("attachmentPayload", () => {
	const outbound = {
		url: "https://cdn.example.com/cat.png",
		name: "cat.png",
		mimeType: "image/png",
	};

	it("sends the file under its name", () => {
		expect(attachmentPayload(outbound)).toEqual({ attachment: outbound.url, name: "cat.png" });
	});

	it("falls back to a generic name", () => {
		expect(attachmentPayload({ ...outbound, name: undefined })).toMatchObject({
			name: "attachment",
		});
	});

	it("sends alt text as the description and prefixes spoilers", () => {
		expect(attachmentPayload({ ...outbound, alt: "A sleeping cat", spoiler: true })).toEqual({
			attachment: outbound.url,
			name: "SPOILER_cat.png",
			description: "A sleeping cat",
		});
	});

	it("does not prefix a spoiler twice", () => {
		expect(
			attachmentPayload({ ...outbound, name: "SPOILER_cat.png", spoiler: true }),
		).toMatchObject({ name: "SPOILER_cat.png" });
	});
});

describe("embedColor", () => {
	it("parses six and three digit hex colors", () => {
		expect(embedColor("#ff8800")).toBe(0xff8800);
		expect(embedColor("0A0")).toBe(0x00aa00);
	});

	it("ignores missing and malformed colors", () => {
		expect(embedColor(undefined)).toBeUndefined();
		expect(embedColor("rgb(1, 2, 3)")).toBeUndefined();
		expect(embedColor("#12345")).toBeUndefined();
	});
});

describe("previewEmbeds", () => {
	const preview = {
		url: "https://example.com/post",
		title: "A post",
		description: "Something happened",
		imageUrl: "https://example.com/image.png",
		themeColor: "#336699",
	};

	it("builds an embed for a preview whose link is not in the message", () => {
		expect(previewEmbeds([preview], ["no links here"], MAX_DISCORD_EMBEDS)).toEqual([
			{
				url: preview.url,
				title: "A post",
				description: "Something happened",
				image: { url: preview.imageUrl },
				color: 0x336699,
			},
		]);
	});

	it("skips previews Discord unfurls from the message itself", () => {
		expect(
			previewEmbeds([preview], ["", `look at [this](${preview.url})`], MAX_DISCORD_EMBEDS),
		).toEqual([]);
	});

	it("falls back to the site name or the link for the title", () => {
		expect(
			previewEmbeds([{ url: preview.url, siteName: "Example" }], [], MAX_DISCORD_EMBEDS),
		).toEqual([{ url: preview.url, title: "Example" }]);
		expect(previewEmbeds([{ url: preview.url }], [], MAX_DISCORD_EMBEDS)).toEqual([
			{ url: preview.url, title: preview.url },
		]);
	});

	it("shortens long descriptions", () => {
		const [embed] = previewEmbeds(
			[{ ...preview, description: "a".repeat(1000) }],
			[],
			MAX_DISCORD_EMBEDS,
		);

		expect(embed?.description).toHaveLength(300);
	});

	it("stops at the room left in the message", () => {
		const previews = Array.from({ length: 12 }, (_, index) => ({
			url: `https://example.com/${index}`,
		}));

		expect(previewEmbeds(previews, [], MAX_DISCORD_EMBEDS - 1)).toHaveLength(9);
		expect(previewEmbeds(previews, [], 0)).toEqual([]);
	});
});
