import type { Dispatcher } from "undici";
import { z } from "zod";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import type { ImageMeasurer } from "./image.js";
import type { EmbedImage, LinkEmbed, MeasuredImage } from "./types.js";

export const YOUTUBE_SITE_NAME = "YouTube";

export const YOUTUBE_CONSENT_COOKIE = "SOCS=CAI; CONSENT=YES+cb";

const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
const OEMBED_MAX_BYTES = 64 * 1024;
const THUMBNAIL_HOST = "https://i.ytimg.com/vi";
const MQDEFAULT_SIZE: MeasuredImage = { width: 320, height: 180 };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TIMESTAMP = /^(?:\d+s?|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/;

const WEB_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const CONSENT_HOSTS = new Set(["consent.youtube.com", "consent.google.com"]);
const CONSENT_TITLES = [
	/^before you continue/i,
	/^ennen kuin jatkat/i,
	/^bevor sie zu youtube weitergehen/i,
];

const PATH_KINDS = {
	shorts: "short",
	live: "live",
	embed: "embed",
} as const;

export type YouTubeLinkKind = "watch" | "short" | "live" | "embed";

export type YouTubeLink = {
	videoId: string;
	kind: YouTubeLinkKind;
	timestamp?: string;
	canonicalUrl: string;
};

const canonicalWatchUrl = (videoId: string, timestamp?: string): string => {
	const url = new URL("https://www.youtube.com/watch");
	url.searchParams.set("v", videoId);
	if (timestamp) url.searchParams.set("t", timestamp);
	return url.href;
};

const pickTimestamp = (url: URL): string | undefined => {
	const raw = url.searchParams.get("t") ?? url.searchParams.get("start") ?? undefined;
	if (!raw || raw === "0" || !TIMESTAMP.test(raw)) return undefined;
	return raw;
};

const videoIdAndKind = (url: URL): { videoId: string; kind: YouTubeLinkKind } | undefined => {
	const host = url.hostname.toLowerCase();
	const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

	if (SHORT_HOSTS.has(host)) {
		const [videoId] = segments;
		return videoId ? { videoId, kind: "watch" } : undefined;
	}
	if (!WEB_HOSTS.has(host)) return undefined;

	const [first, second] = segments;
	if (first === "watch") {
		const videoId = url.searchParams.get("v");
		return videoId ? { videoId, kind: "watch" } : undefined;
	}
	if (first && second && first in PATH_KINDS) {
		return { videoId: second, kind: PATH_KINDS[first as keyof typeof PATH_KINDS] };
	}
	return undefined;
};

export function parseYouTubeUrl(rawUrl: string): YouTubeLink | undefined {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

	const found = videoIdAndKind(url);
	if (!found || !VIDEO_ID.test(found.videoId)) return undefined;

	const timestamp = pickTimestamp(url);
	return {
		videoId: found.videoId,
		kind: found.kind,
		...(timestamp ? { timestamp } : {}),
		canonicalUrl: canonicalWatchUrl(found.videoId, timestamp),
	};
}

export function youtubeFallbackPageUrl(link: YouTubeLink): string {
	const url = new URL(link.canonicalUrl);
	url.searchParams.set("hl", "en");
	url.searchParams.set("gl", "US");
	return url.href;
}

export function isYouTubeConsentPage(embed: LinkEmbed, finalUrl: URL): boolean {
	if (CONSENT_HOSTS.has(finalUrl.hostname.toLowerCase())) return true;
	const title = embed.title?.trim();
	return title !== undefined && CONSENT_TITLES.some((pattern) => pattern.test(title));
}

const oEmbedSchema = z.object({
	title: z.string().min(1),
	author_name: z.string().optional(),
});

type OEmbed = z.infer<typeof oEmbedSchema>;

export type YouTubeEmbedOptions = {
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
	measureImage?: ImageMeasurer;
};

const thumbnailUrl = (videoId: string, name: string): string =>
	`${THUMBNAIL_HOST}/${videoId}/${name}`;

const isVertical = (image: MeasuredImage): boolean => image.height > image.width;

async function measureSafely(
	measureImage: ImageMeasurer,
	url: string,
): Promise<MeasuredImage | undefined> {
	try {
		return await measureImage(url);
	} catch {
		return undefined;
	}
}

async function bestThumbnail(
	link: YouTubeLink,
	measureImage: ImageMeasurer | undefined,
): Promise<EmbedImage> {
	if (measureImage) {
		if (link.kind === "short") {
			const url = thumbnailUrl(link.videoId, "oardefault.jpg");
			const measured = await measureSafely(measureImage, url);
			if (measured && isVertical(measured)) return { url, ...measured };
		}
		const url = thumbnailUrl(link.videoId, "maxresdefault.jpg");
		const measured = await measureSafely(measureImage, url);
		if (measured) return { url, ...measured };
	}

	return { url: thumbnailUrl(link.videoId, "mqdefault.jpg"), ...MQDEFAULT_SIZE };
}

function parseOEmbed(result: GuardedFetchResult): OEmbed | undefined {
	if (result.statusCode < 200 || result.statusCode >= 300 || result.truncated) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(result.body.toString("utf8"));
	} catch {
		return undefined;
	}
	const parsed = oEmbedSchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
}

export async function fetchYouTubeOEmbed(
	rawUrl: string,
	link: YouTubeLink,
	options: YouTubeEmbedOptions = {},
): Promise<LinkEmbed | undefined> {
	const endpoint = new URL(OEMBED_ENDPOINT);
	endpoint.searchParams.set("format", "json");
	endpoint.searchParams.set("url", link.canonicalUrl);

	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(endpoint.href, {
			headers: { accept: "application/json" },
			timeoutMs: options.timeoutMs,
			maxResponseBytes: OEMBED_MAX_BYTES,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
		});
	} catch {
		return undefined;
	}

	const oEmbed = parseOEmbed(result);
	if (!oEmbed) return undefined;

	const image = await bestThumbnail(link, options.measureImage);
	const author = oEmbed.author_name?.trim();

	return {
		uri: rawUrl,
		title: oEmbed.title,
		...(author ? { description: author } : {}),
		siteName: YOUTUBE_SITE_NAME,
		image,
	};
}
