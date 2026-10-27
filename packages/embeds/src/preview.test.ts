import type { MockAgent } from "undici";
import { MockAgent as UndiciMockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewCache } from "./cache.js";
import { extractLinkMetadata, fetchLinkPreview } from "./preview.js";
import type { LinkEmbed } from "./types.js";

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

function newMockAgent(): MockAgent {
	agent = new UndiciMockAgent();
	agent.disableNetConnect();
	return agent;
}

describe("extractLinkMetadata", () => {
	it("extracts open graph tags with precedence over twitter and the title tag", () => {
		const base = new URL("https://example.com/article");
		const html = `
			<html><head>
				<title>Fallback Title</title>
				<meta property="og:title" content="OG Title" />
				<meta name="twitter:title" content="TW Title" />
				<meta property="og:description" content="A description." />
				<meta property="og:site_name" content="Example" />
				<meta property="og:image" content="/img/cover.png" />
				<meta property="og:image:alt" content="Cover" />
			</head><body></body></html>
		`;
		const embed = extractLinkMetadata("https://example.com/article", html, base);
		expect(embed.title).toBe("OG Title");
		expect(embed.description).toBe("A description.");
		expect(embed.siteName).toBe("Example");
		expect(embed.image?.url).toBe("https://example.com/img/cover.png");
		expect(embed.image?.alt).toBe("Cover");
	});

	it("keeps the original requested uri, not the redirect-resolved base", () => {
		const base = new URL("https://final.example.com/landed");
		const embed = extractLinkMetadata("https://short.example/abc", "<html></html>", base);
		expect(embed.uri).toBe("https://short.example/abc");
	});

	it("falls through to twitter:image when og:image points at the page itself", () => {
		const base = new URL("https://lou.gg/");
		const html = `
			<html><head>
				<meta property="og:image" content="https://lou.gg/" />
				<meta property="og:url" content="https://lou.gg/" />
				<meta name="twitter:image" content="/img/og.png" />
				<meta property="og:title" content="Louis" />
			</head></html>
		`;
		const embed = extractLinkMetadata("https://lou.gg/", html, base);
		expect(embed.image?.url).toBe("https://lou.gg/img/og.png");
	});

	it("picks the mp4 when a page lists both mp4 and webm", () => {
		const base = new URL("https://tenor.com/view/cat-cat-meme-cute-cat-gif-11036838802643676822");
		const html = `
			<html><head>
				<meta property="og:image" content="https://media1.tenor.com/m/abc/cat.gif" />
				<meta property="og:video" content="https://media.tenor.com/abc/cat.mp4" />
				<meta property="og:video" content="https://media.tenor.com/abc/cat.webm" />
				<meta property="og:video:type" content="video/mp4" />
				<meta property="og:video:width" content="498" />
				<meta property="og:video:height" content="498" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.video?.url).toBe("https://media.tenor.com/abc/cat.mp4");
		expect(embed.video?.mimeType).toBe("video/mp4");
		expect(embed.video?.width).toBe(498);
	});

	it("accepts an extensionless video on its declared content type", () => {
		const base = new URL("https://gifbox.me/view/abc-anime-spray-face");
		const html = `
			<html><head>
				<meta property="og:image" content="https://rpc.gifbox.me/media/post/abc/poster" />
				<meta property="og:video" content="https://rpc.gifbox.me/media/post/abc/mp4" />
				<meta property="og:video:type" content="video/mp4" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.video?.url).toBe("https://rpc.gifbox.me/media/post/abc/mp4");
		expect(embed.video?.mimeType).toBe("video/mp4");
	});

	it("rejects a video candidate that is really an html embed page", () => {
		const base = new URL("https://www.youtube.com/watch?v=abc");
		const html = `
			<html><head>
				<meta property="og:image" content="https://i.ytimg.com/vi/abc/hq.jpg" />
				<meta property="og:video:secure_url" content="https://www.youtube.com/embed/abc" />
				<meta property="og:video:type" content="text/html" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.video).toBeUndefined();
	});

	it("falls back to the twitter player stream", () => {
		const base = new URL("https://example.com/clip");
		const html = `
			<html><head>
				<meta property="og:image" content="/poster.png" />
				<meta name="twitter:player:stream" content="https://cdn.example.com/clip" />
				<meta name="twitter:player:stream:content_type" content="video/webm" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.video?.url).toBe("https://cdn.example.com/clip");
		expect(embed.video?.mimeType).toBe("video/webm");
	});

	it("extracts a declared video duration", () => {
		const base = new URL("https://example.com/clip");
		const html = `
			<html><head>
				<meta property="og:video" content="/clip.mp4" />
				<meta property="og:video:duration" content="42" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.video?.duration).toBe(42);
	});

	it("keeps a lone declared image dimension", () => {
		const base = new URL("https://example.com/p");
		const html = `
			<html><head>
				<meta property="og:image" content="/hero.png" />
				<meta property="og:image:width" content="200" />
			</head></html>
		`;
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.image?.width).toBe(200);
		expect(embed.image?.height).toBeUndefined();
	});

	it("falls back to the title tag and the host for site name", () => {
		const base = new URL("https://news.example.org/x");
		const html = "<html><head><title>  Just A Title  </title></head><body></body></html>";
		const embed = extractLinkMetadata(base.href, html, base);
		expect(embed.title).toBe("Just A Title");
		expect(embed.siteName).toBe("news.example.org");
		expect(embed.description).toBeUndefined();
		expect(embed.image).toBeUndefined();
	});

	it("returns just the uri when there is no usable metadata", () => {
		const base = new URL("https://example.com");
		const embed = extractLinkMetadata(base.href, "<html><head></head><body>hi</body></html>", base);
		expect(embed).toEqual({ uri: base.href, siteName: "example.com" });
	});
});

describe("fetchLinkPreview image measurement", () => {
	const page = (extraMeta = "") => `
		<html><head>
			<meta property="og:title" content="A Livestream" />
			<meta property="og:image" content="https://1.1.1.1/card.jpg" />
			${extraMeta}
		</head></html>
	`;

	const servePage = (mockAgent: MockAgent, extraMeta = ""): void => {
		mockAgent
			.get("http://93.184.216.34")
			.intercept({ path: "/watch", method: "GET" })
			.reply(200, page(extraMeta), { headers: { "content-type": "text/html" } });
	};

	it("fills in dimensions the page never declared", async () => {
		const mockAgent = newMockAgent();
		servePage(mockAgent);
		const measureImage = vi.fn(async () => ({ width: 1200, height: 630 }));

		const embed = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache: null,
			measureImage,
		});

		expect(measureImage).toHaveBeenCalledWith("https://1.1.1.1/card.jpg");
		expect(embed.image?.width).toBe(1200);
		expect(embed.image?.height).toBe(630);
	});

	it("leaves declared dimensions alone", async () => {
		const mockAgent = newMockAgent();
		servePage(
			mockAgent,
			`<meta property="og:image:width" content="64" />
			 <meta property="og:image:height" content="64" />`,
		);
		const measureImage = vi.fn(async () => ({ width: 1200, height: 630 }));

		const embed = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache: null,
			measureImage,
		});

		expect(measureImage).not.toHaveBeenCalled();
		expect(embed.image?.width).toBe(64);
	});

	it("measures again when only one dimension is declared", async () => {
		const mockAgent = newMockAgent();
		servePage(mockAgent, '<meta property="og:image:width" content="1200" />');
		const measureImage = vi.fn(async () => ({ width: 1200, height: 630 }));

		const embed = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache: null,
			measureImage,
		});

		expect(embed.image?.height).toBe(630);
	});

	it("keeps the preview when the measurer throws", async () => {
		const mockAgent = newMockAgent();
		servePage(mockAgent);
		const measureImage = vi.fn(async () => {
			throw new Error("image host is down");
		});

		const embed = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache: null,
			measureImage,
		});

		expect(embed.title).toBe("A Livestream");
		expect(embed.image?.url).toBe("https://1.1.1.1/card.jpg");
		expect(embed.image?.width).toBeUndefined();
	});

	it("keeps the preview when the measurer finds no dimensions", async () => {
		const mockAgent = newMockAgent();
		servePage(mockAgent);

		const embed = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache: null,
			measureImage: async () => undefined,
		});

		expect(embed.image?.width).toBeUndefined();
	});

	it("serves measured dimensions from the cache without measuring twice", async () => {
		const mockAgent = newMockAgent();
		servePage(mockAgent);
		const cache = createPreviewCache<LinkEmbed>();
		const measureImage = vi.fn(async () => ({ width: 1200, height: 630 }));

		const first = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache,
			measureImage,
		});
		const second = await fetchLinkPreview("http://93.184.216.34/watch", {
			dispatcher: mockAgent,
			cache,
			measureImage,
		});

		expect(measureImage).toHaveBeenCalledTimes(1);
		expect(first.image?.height).toBe(630);
		expect(second.image?.height).toBe(630);
	});
});

describe("extractLinkMetadata card hints", () => {
	const base = new URL("https://example.com/post");
	const html = `
		<html><head>
			<meta name="theme-color" content="#ABC" />
			<meta name="twitter:card" content="summary" />
			<meta property="og:site_name" content="Example" />
			<meta property="article:published_time" content="2026-10-01T12:00:00+02:00" />
			<meta property="og:image" content="/1.png" />
			<meta property="og:image" content="/2.png" />
			<link rel="icon" type="image/svg+xml" href="/icon.svg">
			<link rel="icon" sizes="16x16" href="/icon16.png">
			<link rel="icon" sizes="64x64" href="/icon64.png">
			<link rel="icon" sizes="32x32" href="/icon32.png">
		</head></html>
	`;

	it("reads theme color, layout, publish date, icon and gallery", () => {
		const embed = extractLinkMetadata("https://example.com/post", html, base);
		expect(embed.themeColor).toBe("#aabbcc");
		expect(embed.layout).toBe("summary");
		expect(embed.publishedAt).toBe("2026-10-01T10:00:00.000Z");
		expect(embed.provider).toEqual({ name: "Example", icon: "https://example.com/icon32.png" });
		expect(embed.media).toEqual([
			{ kind: "image", url: "https://example.com/1.png" },
			{ kind: "image", url: "https://example.com/2.png" },
		]);
	});

	it("ignores invalid theme colors", () => {
		const embed = extractLinkMetadata(
			"https://example.com/post",
			'<meta name="theme-color" content="red">',
			base,
		);
		expect(embed.themeColor).toBeUndefined();
	});
});

describe("fetchLinkPreview enrichment", () => {
	it("merges oEmbed provider and a Mastodon status into the card", async () => {
		const mockAgent = newMockAgent();
		const origin = mockAgent.get("http://93.184.216.34");
		origin.intercept({ path: "/@jane/1", method: "GET" }).reply(
			200,
			`<html><head>
				<meta property="og:title" content="Jane (@jane)" />
				<meta property="og:description" content="Plain text" />
				<link rel="alternate" type="application/json+oembed" href="/oembed">
				<link rel="alternate" type="application/activity+json" href="/users/jane/statuses/1">
			</head></html>`,
			{ headers: { "content-type": "text/html" } },
		);
		origin
			.intercept({ path: "/oembed", method: "GET" })
			.reply(200, JSON.stringify({ provider_name: "Example Social", author_name: "Jane" }));
		origin.intercept({ path: "/api/v1/statuses/1", method: "GET" }).reply(
			200,
			JSON.stringify({
				created_at: "2026-10-01T00:00:00Z",
				content: "<p><strong>Hi</strong></p>",
				account: { username: "jane", display_name: "Jane", url: "http://93.184.216.34/@jane" },
				media_attachments: [],
			}),
		);

		const embed = await fetchLinkPreview("http://93.184.216.34/@jane/1", {
			dispatcher: mockAgent,
			cache: null,
		});

		expect(embed.provider?.name).toBe("Example Social");
		expect(embed.author?.handle).toBe("jane@93.184.216.34");
		expect(embed.description).toBeUndefined();
		expect(embed.post?.body).toEqual([{ kind: "paragraph", spans: [{ text: "Hi", bold: true }] }]);
	});

	it("keeps the plain card when the status fetch fails", async () => {
		const mockAgent = newMockAgent();
		const origin = mockAgent.get("http://93.184.216.34");
		origin.intercept({ path: "/@jane/1", method: "GET" }).reply(
			200,
			`<html><head>
				<meta property="og:description" content="Plain text" />
				<link rel="alternate" type="application/activity+json" href="/users/jane/statuses/1">
			</head></html>`,
			{ headers: { "content-type": "text/html" } },
		);
		origin.intercept({ path: "/api/v1/statuses/1", method: "GET" }).reply(404, "{}");

		const embed = await fetchLinkPreview("http://93.184.216.34/@jane/1", {
			dispatcher: mockAgent,
			cache: null,
		});

		expect(embed.description).toBe("Plain text");
		expect(embed.post).toBeUndefined();
	});
});

describe("fetchLinkPreview direct image links", () => {
	const resolveHost = async () => [{ address: "93.184.216.34", family: 4 as const }];

	it("previews an svg served from a png path as an image", async () => {
		const url = "https://mail.ehis.gay/api/share/EPszVlbbHi1bXMEJKyaLh2fz/og.png";
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://mail.ehis.gay")
			.intercept({ path: "/api/share/EPszVlbbHi1bXMEJKyaLh2fz/og.png", method: "GET" })
			.reply(200, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>', {
				headers: { "content-type": "image/svg+xml; charset=utf-8" },
			});

		const embed = await fetchLinkPreview(url, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
		});

		expect(embed).toEqual({
			uri: url,
			image: { url },
			media: [{ kind: "image", url, mimeType: "image/svg+xml" }],
		});
	});

	it("previews an extensionless png link as an image with its measured size", async () => {
		const url = "https://eusv.net/Z3IHTWsCwrBqzZcL";
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://eusv.net")
			.intercept({ path: "/Z3IHTWsCwrBqzZcL", method: "GET" })
			.reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
				headers: { "content-type": "image/png" },
			});
		const measureImage = vi.fn(async () => ({ width: 800, height: 600 }));

		const embed = await fetchLinkPreview(url, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
			measureImage,
		});

		expect(measureImage).toHaveBeenCalledWith(url);
		expect(embed).toEqual({
			uri: url,
			image: { url, width: 800, height: 600 },
			media: [{ kind: "image", url, mimeType: "image/png", width: 800, height: 600 }],
		});
	});

	it("keeps treating an unsupported image type as a page", async () => {
		const url = "https://eusv.net/favicon";
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://eusv.net")
			.intercept({ path: "/favicon", method: "GET" })
			.reply(200, Buffer.from([0, 0, 1, 0]), { headers: { "content-type": "image/x-icon" } });

		const embed = await fetchLinkPreview(url, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
		});

		expect(embed.image).toBeUndefined();
		expect(embed.media).toBeUndefined();
	});
});
