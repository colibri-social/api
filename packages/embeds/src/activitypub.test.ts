import { describe, expect, it } from "vitest";
import { findStatusApiUrl, statusToPost } from "./activitypub.js";

const status = {
	created_at: "2026-10-17T18:22:55.836Z",
	content: '<p>Hello <a href="https://mastodon.social/@Ameboid">@Ameboid</a></p>',
	sensitive: true,
	spoiler_text: "eye contact",
	replies_count: 31,
	reblogs_count: 51,
	favourites_count: 419,
	account: {
		username: "Gargron",
		acct: "Gargron",
		display_name: "Eugen Rochko",
		url: "https://mastodon.social/@Gargron",
		avatar: "https://files.mastodon.social/a.png",
		avatar_static: "https://files.mastodon.social/a-static.png",
	},
	media_attachments: [
		{
			type: "image",
			url: "https://files.mastodon.social/1.jpeg",
			preview_url: "https://files.mastodon.social/1-small.jpeg",
			description: "A photo",
			meta: { original: { width: 2499, height: 3319 } },
		},
		{
			type: "gifv",
			url: "https://files.mastodon.social/2.mp4",
			preview_url: "https://files.mastodon.social/2.png",
			meta: { original: { width: 480, height: 270 } },
		},
		{ type: "audio", url: "https://files.mastodon.social/3.mp3" },
	],
};

describe("findStatusApiUrl", () => {
	it("maps an activity+json status link to the Mastodon status API", () => {
		const url = findStatusApiUrl(
			[
				{
					rel: ["alternate"],
					type: "application/activity+json",
					href: "https://mastodon.social/users/Gargron/statuses/117457641525342383",
				},
			],
			new URL("https://mastodon.social/@Gargron/117457641525342383"),
		);
		expect(url).toBe("https://mastodon.social/api/v1/statuses/117457641525342383");
	});

	it("ignores activity links that are not statuses", () => {
		const url = findStatusApiUrl(
			[{ rel: ["alternate"], type: "application/activity+json", href: "/users/Gargron" }],
			new URL("https://mastodon.social/@Gargron"),
		);
		expect(url).toBeUndefined();
	});
});

describe("statusToPost", () => {
	it("maps author, body, warning, stats and media", () => {
		expect(statusToPost(status)).toEqual({
			author: {
				name: "Eugen Rochko",
				handle: "Gargron@mastodon.social",
				url: "https://mastodon.social/@Gargron",
				avatar: "https://files.mastodon.social/a-static.png",
			},
			publishedAt: "2026-10-17T18:22:55.836Z",
			post: {
				body: [
					{
						kind: "paragraph",
						spans: [
							{ text: "Hello " },
							{ text: "@Ameboid", href: "https://mastodon.social/@Ameboid" },
						],
					},
				],
				sensitive: true,
				contentWarning: "eye contact",
				stats: { replies: 31, reposts: 51, likes: 419 },
			},
			media: [
				{
					kind: "image",
					url: "https://files.mastodon.social/1.jpeg",
					width: 2499,
					height: 3319,
					alt: "A photo",
				},
				{
					kind: "gifv",
					url: "https://files.mastodon.social/2.mp4",
					mimeType: "video/mp4",
					previewUrl: "https://files.mastodon.social/2.png",
					width: 480,
					height: 270,
				},
			],
		});
	});

	it("shows the original post of a reblog", () => {
		const post = statusToPost({
			...status,
			account: { ...status.account, username: "booster", acct: "booster@other.example" },
			reblog: status,
		});
		expect(post?.author.name).toBe("Eugen Rochko");
	});

	it("rejects payloads that are not statuses", () => {
		expect(statusToPost({ error: "Record not found" })).toBeUndefined();
	});
});
