import { type MockAgent, MockAgent as UndiciMockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmbedError } from "./errors.js";
import type { HostResolver } from "./fetch.js";
import { fetchLinkPreview } from "./preview.js";
import { parseYouTubeUrl, YOUTUBE_CONSENT_COOKIE } from "./youtube.js";

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

const newMockAgent = (): MockAgent => {
	agent = new UndiciMockAgent();
	agent.disableNetConnect();
	return agent;
};

const resolveHost: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

const VIDEO = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;

const oEmbedBody = {
	title: "Never Gonna Give You Up",
	author_name: "Rick Astley",
	thumbnail_url: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`,
	thumbnail_width: 480,
	thumbnail_height: 360,
};

const isOEmbedPath = (path: string) => path.startsWith("/oembed?");

const serveOEmbed = (mockAgent: MockAgent, statusCode: number, body: unknown) =>
	mockAgent
		.get("https://www.youtube.com")
		.intercept({
			path: isOEmbedPath,
			method: "GET",
			headers: { "accept-language": "en-US,en;q=0.9" },
		})
		.reply(statusCode, typeof body === "string" ? body : JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});

const watchPage = (title: string) => `
	<html><head>
		<meta property="og:title" content="${title}" />
		<meta property="og:site_name" content="YouTube" />
		<meta property="og:image" content="https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg" />
		<meta property="og:image:width" content="1280" />
		<meta property="og:image:height" content="720" />
	</head></html>
`;

const serveWatchPage = (mockAgent: MockAgent, html: string) =>
	mockAgent
		.get("https://www.youtube.com")
		.intercept({
			path: (path) => path.startsWith("/watch?") && path.includes("hl=en"),
			method: "GET",
			headers: {
				cookie: YOUTUBE_CONSENT_COOKIE,
				"accept-language": "en-US,en;q=0.9",
				accept: (value) => value.startsWith("text/html"),
			},
		})
		.reply(200, html, { headers: { "content-type": "text/html" } });

describe("parseYouTubeUrl", () => {
	it.each([
		["watch", WATCH, "watch"],
		["mobile watch", `https://m.youtube.com/watch?v=${VIDEO}&feature=share`, "watch"],
		["music", `https://music.youtube.com/watch?v=${VIDEO}&list=RDAMVM`, "watch"],
		["short link", `https://youtu.be/${VIDEO}?si=abc`, "watch"],
		["shorts", `https://www.youtube.com/shorts/${VIDEO}`, "short"],
		["live", `https://youtube.com/live/${VIDEO}?feature=shared`, "live"],
		["embed", `https://www.youtube.com/embed/${VIDEO}`, "embed"],
	])("normalises a %s link", (_label, raw, kind) => {
		expect(parseYouTubeUrl(raw)).toEqual({ videoId: VIDEO, kind, canonicalUrl: WATCH });
	});

	it("keeps a t timestamp", () => {
		expect(parseYouTubeUrl(`https://youtu.be/${VIDEO}?t=42`)?.canonicalUrl).toBe(`${WATCH}&t=42`);
		expect(parseYouTubeUrl(`${WATCH}&t=1m30s`)?.canonicalUrl).toBe(`${WATCH}&t=1m30s`);
	});

	it("carries an embed start time over as t", () => {
		expect(parseYouTubeUrl(`https://www.youtube.com/embed/${VIDEO}?start=90`)?.timestamp).toBe(
			"90",
		);
	});

	it("drops a malformed timestamp", () => {
		expect(parseYouTubeUrl(`${WATCH}&t=soon`)?.canonicalUrl).toBe(WATCH);
	});

	it.each([
		["a channel page", "https://www.youtube.com/@RickAstleyYT"],
		["a bad video id", "https://www.youtube.com/watch?v=short"],
		["another host", `https://notyoutube.com/watch?v=${VIDEO}`],
		["a playlist", "https://www.youtube.com/playlist?list=PL123"],
		["not a url", "youtube"],
	])("ignores %s", (_label, raw) => {
		expect(parseYouTubeUrl(raw)).toBeUndefined();
	});
});

describe("fetchLinkPreview for YouTube", () => {
	it("maps oEmbed onto the embed with the maxres thumbnail", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 200, oEmbedBody);
		const measureImage = vi.fn(async () => ({ width: 1280, height: 720 }));
		const raw = `https://youtu.be/${VIDEO}?t=42`;

		const embed = await fetchLinkPreview(raw, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
			measureImage,
		});

		expect(embed).toEqual({
			uri: raw,
			title: "Never Gonna Give You Up",
			description: "Rick Astley",
			siteName: "YouTube",
			image: {
				url: `https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg`,
				width: 1280,
				height: 720,
			},
		});
		expect(measureImage).toHaveBeenCalledWith(`https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg`);
	});

	it("falls back to the 16:9 mqdefault thumbnail when maxres is missing", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 200, oEmbedBody);

		const embed = await fetchLinkPreview(WATCH, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
			measureImage: async () => undefined,
		});

		expect(embed.image).toEqual({
			url: `https://i.ytimg.com/vi/${VIDEO}/mqdefault.jpg`,
			width: 320,
			height: 180,
		});
	});

	it("uses mqdefault without measuring when no measurer is given", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 200, oEmbedBody);

		const embed = await fetchLinkPreview(WATCH, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
		});

		expect(embed.image).toEqual({
			url: `https://i.ytimg.com/vi/${VIDEO}/mqdefault.jpg`,
			width: 320,
			height: 180,
		});
	});

	it("keeps a vertical thumbnail for Shorts", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 200, oEmbedBody);
		const measureImage = vi.fn(async (url: string) =>
			url.endsWith("oardefault.jpg") ? { width: 1080, height: 1920 } : { width: 1280, height: 720 },
		);

		const embed = await fetchLinkPreview(`https://www.youtube.com/shorts/${VIDEO}`, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
			measureImage,
		});

		expect(embed.image).toEqual({
			url: `https://i.ytimg.com/vi/${VIDEO}/oardefault.jpg`,
			width: 1080,
			height: 1920,
		});
	});

	it("falls back to the watch page with the consent cookie when oEmbed refuses", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 401, "Unauthorized");
		serveWatchPage(mockAgent, watchPage("Age Restricted Video"));

		const embed = await fetchLinkPreview(WATCH, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
		});

		expect(embed.title).toBe("Age Restricted Video");
		expect(embed.siteName).toBe("YouTube");
		expect(embed.uri).toBe(WATCH);
		expect(embed.image?.width).toBe(1280);
	});

	it("falls back when oEmbed returns something other than oEmbed JSON", async () => {
		const mockAgent = newMockAgent();
		serveOEmbed(mockAgent, 200, "<html>nope</html>");
		serveWatchPage(mockAgent, watchPage("Some Video"));

		const embed = await fetchLinkPreview(WATCH, {
			dispatcher: mockAgent,
			resolveHost,
			cache: null,
		});

		expect(embed.title).toBe("Some Video");
	});

	it.each(["Before you continue to YouTube", "Ennen kuin jatkat YouTubeen"])(
		"rejects a consent page titled '%s'",
		async (title) => {
			const mockAgent = newMockAgent();
			serveOEmbed(mockAgent, 404, "Not Found");
			serveWatchPage(mockAgent, watchPage(title));

			const failure = await fetchLinkPreview(WATCH, {
				dispatcher: mockAgent,
				resolveHost,
				cache: null,
			}).catch((error: unknown) => error);

			expect(isEmbedError(failure) && failure.code).toBe("UpstreamFailure");
		},
	);
});

describe("fetchLinkPreview locale headers", () => {
	it("asks generic pages for English html", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("http://93.184.216.34")
			.intercept({
				path: "/article",
				method: "GET",
				headers: {
					"accept-language": "en-US,en;q=0.9",
					accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
				},
			})
			.reply(200, "<html><head><title>Hello</title></head></html>", {
				headers: { "content-type": "text/html" },
			});

		const embed = await fetchLinkPreview("http://93.184.216.34/article", {
			dispatcher: mockAgent,
			cache: null,
		});

		expect(embed.title).toBe("Hello");
	});
});
