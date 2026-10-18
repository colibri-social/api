import type { MockAgent } from "undici";
import { MockAgent as UndiciMockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { HostResolver } from "./fetch.js";
import { parseXStatusUrl, xStatusApiUrl, xStatusToEmbed } from "./fxtwitter.js";
import { fetchLinkPreview } from "./preview.js";

const resolveHost: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

const author = (handle: string, name: string) => ({
	screen_name: handle,
	name,
	url: `https://x.com/${handle}`,
	avatar_url: `https://pbs.twimg.com/${handle}.jpg`,
});

const response = {
	code: 200,
	status: {
		url: "https://x.com/Yuushimo2333/status/2110299554096800008",
		text: "",
		raw_text: {
			text: "https://t.co/jEUVf5Z24b",
			display_text_range: [0, 0],
			facets: [{ type: "media", indices: [0, 23] }],
		},
		author: author("Yuushimo2333", "幽霜Yuushimo"),
		replies: 18,
		reposts: 42,
		likes: 373,
		views: 12428,
		created_timestamp: 1791969595,
		possibly_sensitive: false,
		media: {
			all: [
				{
					type: "video",
					url: "https://video.twimg.com/a.mp4",
					thumbnail_url: "https://pbs.twimg.com/a.jpg",
					width: 720,
					height: 1564,
					format: "video/mp4",
				},
			],
		},
		quote: {
			url: "https://x.com/FrankkkkkkLau/status/2110052209069273537",
			text: "outlook疯了",
			raw_text: { text: "outlook疯了 https://t.co/x", display_text_range: [0, 9], facets: [] },
			translation: { text: "Outlook has gone crazy", source_lang: "zh" },
			author: author("FrankkkkkkLau", "Frank"),
			created_timestamp: 1791910624,
		},
	},
};

describe("parseXStatusUrl", () => {
	it("reads X and fixer links with an optional language suffix", () => {
		expect(
			parseXStatusUrl("https://fixupx.com/Yuushimo2333/status/2110299554096800008/en"),
		).toEqual({
			id: "2110299554096800008",
			handle: "Yuushimo2333",
			language: "en",
			provider: {
				name: "FixupX",
				url: "https://fixupx.com",
				icon: "https://assets.fxembed.com/logos/fixupx64.png",
			},
			themeColor: "#6363ff",
		});
		expect(parseXStatusUrl("https://x.com/i/status/123")?.provider.name).toBe("X");
		expect(parseXStatusUrl("https://d.fxtwitter.com/a/status/123/photo/1")?.id).toBe("123");
		expect(parseXStatusUrl("https://twitter.com/a/status/123/photo/1")?.language).toBeUndefined();
	});

	it("rejects other hosts and paths", () => {
		expect(parseXStatusUrl("https://example.com/a/status/123")).toBeUndefined();
		expect(parseXStatusUrl("https://x.com/a")).toBeUndefined();
		expect(parseXStatusUrl("https://x.com/a/status/abc")).toBeUndefined();
	});

	it("asks the API for a translation when a language is given", () => {
		const link = parseXStatusUrl("https://fixupx.com/a/status/1/en");
		expect(link && xStatusApiUrl(link)).toBe("https://api.fxtwitter.com/2/status/1?lang=en");
	});
});

describe("xStatusToEmbed", () => {
	const link = parseXStatusUrl("https://fixupx.com/Yuushimo2333/status/2110299554096800008/en");

	it("maps the post, stats, media and translated quote", () => {
		if (!link) throw new Error("unparsed");
		const embed = xStatusToEmbed("https://fixupx.com/x", link, response);
		expect(embed?.author).toEqual({
			name: "幽霜Yuushimo",
			handle: "Yuushimo2333",
			url: "https://x.com/Yuushimo2333",
			avatar: "https://pbs.twimg.com/Yuushimo2333.jpg",
		});
		expect(embed?.themeColor).toBe("#6363ff");
		expect(embed?.publishedAt).toBe("2026-10-14T09:19:55.000Z");
		expect(embed?.media).toEqual([
			{
				kind: "video",
				url: "https://video.twimg.com/a.mp4",
				mimeType: "video/mp4",
				previewUrl: "https://pbs.twimg.com/a.jpg",
				width: 720,
				height: 1564,
			},
		]);
		expect(embed?.post?.body).toEqual([]);
		expect(embed?.post?.stats).toEqual({ replies: 18, reposts: 42, likes: 373, views: 12428 });
		expect(embed?.post?.quote).toMatchObject({
			uri: "https://x.com/FrankkkkkkLau/status/2110052209069273537",
			body: [{ kind: "paragraph", spans: [{ text: "Outlook has gone crazy" }] }],
			translatedFrom: "zh",
		});
	});

	it("turns url, mention and hashtag facets into links and drops media links", () => {
		if (!link) throw new Error("unparsed");
		const text = "Hi @bob see https://t.co/abc #cats https://t.co/pic";
		const embed = xStatusToEmbed("https://fixupx.com/x", link, {
			status: {
				...response.status,
				quote: undefined,
				raw_text: {
					text,
					display_text_range: [0, text.length],
					facets: [
						{ type: "mention", indices: [3, 7] },
						{
							type: "url",
							indices: [12, 28],
							display: "example.com/page",
							replacement: "https://example.com/page",
						},
						{ type: "hashtag", indices: [29, 34] },
						{ type: "media", indices: [35, 51] },
					],
				},
			},
		});
		expect(embed?.post?.body).toEqual([
			{
				kind: "paragraph",
				spans: [
					{ text: "Hi " },
					{ text: "@bob", href: "https://x.com/bob" },
					{ text: " see " },
					{ text: "example.com/page", href: "https://example.com/page" },
					{ text: " " },
					{ text: "#cats", href: "https://x.com/hashtag/cats" },
				],
			},
		]);
	});

	it("rejects error payloads", () => {
		if (!link) throw new Error("unparsed");
		expect(xStatusToEmbed("https://fixupx.com/x", link, { code: 404 })).toBeUndefined();
	});
});

describe("fetchLinkPreview for X links", () => {
	it("uses the FxEmbed API", async () => {
		agent = new UndiciMockAgent();
		agent.disableNetConnect();
		agent
			.get("https://api.fxtwitter.com")
			.intercept({ path: "/2/status/2110299554096800008?lang=en", method: "GET" })
			.reply(200, JSON.stringify(response), { headers: { "content-type": "application/json" } });

		const embed = await fetchLinkPreview(
			"https://fixupx.com/Yuushimo2333/status/2110299554096800008/en",
			{ dispatcher: agent, resolveHost, cache: null },
		);
		expect(embed.provider?.name).toBe("FixupX");
		expect(embed.post?.stats?.likes).toBe(373);
	});
});
