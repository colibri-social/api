import type { Dispatcher } from "undici";
import { fetchActivityPost, findStatusApiUrl } from "./activitypub.js";
import type { TtlCache } from "./cache.js";
import { createPreviewCache, normalizeUrlCacheKey } from "./cache.js";
import { isEmbedError, notFetchable, upstreamFailure } from "./errors.js";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import { fetchXStatusPreview, parseXStatusUrl } from "./fxtwitter.js";
import {
	containsHeadClose,
	extractLinkTags,
	extractMetaTags,
	extractMetaValues,
	extractTitleTag,
	type LinkTag,
} from "./html.js";
import { type ImageMeasurer, type LinkedImageType, linkedImageType } from "./image.js";
import { fetchOEmbed, findOEmbedUrl } from "./oembed.js";
import type {
	EmbedImage,
	EmbedLayout,
	EmbedMedia,
	EmbedProvider,
	EmbedVideo,
	LinkEmbed,
	MeasuredImage,
} from "./types.js";
import { type PlayableVideoType, playableVideoType, videoTypeFromExtension } from "./video.js";
import {
	fetchYouTubeOEmbed,
	isYouTubeConsentPage,
	parseYouTubeUrl,
	YOUTUBE_CONSENT_COOKIE,
	YOUTUBE_SITE_NAME,
	type YouTubeLink,
	youtubeFallbackPageUrl,
} from "./youtube.js";

const DEFAULT_MAX_HEAD_BYTES = 1024 * 1024;

export const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

let defaultPreviewCache: TtlCache<LinkEmbed> | undefined;

function resolveDefaultPreviewCache(): TtlCache<LinkEmbed> {
	defaultPreviewCache ??= createPreviewCache<LinkEmbed>();
	return defaultPreviewCache;
}

export type LinkPreviewOptions = {
	timeoutMs?: number;
	maxRedirects?: number;
	maxBytes?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
	cache?: TtlCache<LinkEmbed> | null;
	measureImage?: ImageMeasurer;
};

function resolveUrl(raw: string | undefined, base: URL): URL | undefined {
	if (!raw) return undefined;
	try {
		return new URL(raw, base);
	} catch {
		return undefined;
	}
}

function parsePositiveInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const MAX_GALLERY_IMAGES = 4;
const MIN_ICON_SIZE = 32;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RASTER_ICON = /\.(png|jpe?g|webp|gif)$/i;

const LAYOUTS: Record<string, EmbedLayout> = {
	summary: "summary",
	summary_large_image: "largeImage",
	player: "player",
};

export function parseThemeColor(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value || !HEX_COLOR.test(value)) return undefined;
	const hex = value.slice(1).toLowerCase();
	if (hex.length === 6) return `#${hex}`;
	return `#${[...hex].map((digit) => digit + digit).join("")}`;
}

function parsePublishedAt(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const time = Date.parse(raw);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

const iconSize = (sizes: string | undefined): number | undefined => {
	if (!sizes) return undefined;
	const sides = sizes
		.split(/\s+/)
		.map((entry) => Number.parseInt(entry.split("x")[0] ?? "", 10))
		.filter((side) => Number.isFinite(side));
	return sides.length > 0 ? Math.max(...sides) : undefined;
};

export function pickIconUrl(links: readonly LinkTag[], base: URL): string | undefined {
	const raster = (link: LinkTag): URL | undefined => {
		const url = resolveUrl(link.href, base);
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
		if (link.type === "image/svg+xml" || link.type === "image/x-icon") return undefined;
		if (link.type?.startsWith("image/")) return url;
		return RASTER_ICON.test(url.pathname) ? url : undefined;
	};

	const icons = links
		.filter((link) => link.rel.includes("icon") && !link.rel.includes("mask-icon"))
		.map((link) => ({ url: raster(link), size: iconSize(link.sizes) }))
		.filter((entry): entry is { url: URL; size: number | undefined } => entry.url !== undefined);

	const sized = icons
		.filter((entry) => (entry.size ?? 0) >= MIN_ICON_SIZE)
		.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
	const chosen = sized[0] ?? icons.find((entry) => entry.size === undefined);
	if (chosen) return chosen.url.href;

	const touch = links.find((link) => link.rel.includes("apple-touch-icon"));
	return touch ? raster({ ...touch, type: touch.type ?? "image/png" })?.href : undefined;
}

export function extractLinkMetadata(uri: string, html: string, base: URL): LinkEmbed {
	const metas = extractMetaTags(html);
	const get = (key: string): string | undefined => metas.get(key);
	const declaredDimension = (primaryKey: string, fallbackKey: string): number | undefined =>
		parsePositiveInt(get(primaryKey) ?? get(fallbackKey));

	const title = get("og:title") ?? get("twitter:title") ?? extractTitleTag(html);
	const description = get("og:description") ?? get("twitter:description") ?? get("description");
	const siteName = get("og:site_name") ?? base.hostname;

	const pageUrl = resolveUrl(get("og:url"), base) ?? base;

	const imageUrl = [
		"og:image",
		"og:image:url",
		"og:image:secure_url",
		"twitter:image",
		"twitter:image:src",
	]
		.map((key) => resolveUrl(get(key), base))
		.find(
			(candidate): candidate is URL =>
				candidate !== undefined && candidate.href !== pageUrl.href && candidate.href !== base.href,
		);

	const imageAlt = get("og:image:alt") ?? get("twitter:image:alt");
	const imageWidth = declaredDimension("og:image:width", "twitter:image:width");
	const imageHeight = declaredDimension("og:image:height", "twitter:image:height");

	const image: EmbedImage | undefined = imageUrl
		? {
				url: imageUrl.href,
				...(imageAlt ? { alt: imageAlt } : {}),
				...(imageWidth !== undefined ? { width: imageWidth } : {}),
				...(imageHeight !== undefined ? { height: imageHeight } : {}),
			}
		: undefined;

	const declaredVideoType = ["og:video:type", "twitter:player:stream:content_type"]
		.map((key) => get(key))
		.filter((value): value is string => value !== undefined)
		.map((value) => playableVideoType(value))
		.find((value): value is PlayableVideoType => value !== undefined);

	let video: EmbedVideo | undefined;
	for (const key of ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]) {
		const candidate = resolveUrl(get(key), base);
		if (!candidate) continue;
		if (candidate.href === pageUrl.href || candidate.href === base.href) continue;

		const mimeType = videoTypeFromExtension(candidate) ?? declaredVideoType;
		if (!mimeType) continue;

		const width = declaredDimension("og:video:width", "twitter:player:width");
		const height = declaredDimension("og:video:height", "twitter:player:height");
		const duration = declaredDimension("og:video:duration", "video:duration");

		video = {
			url: candidate.href,
			mimeType,
			...(width !== undefined ? { width } : {}),
			...(height !== undefined ? { height } : {}),
			...(duration !== undefined ? { duration } : {}),
		};
		break;
	}

	const galleryUrls = [
		...new Set(
			extractMetaValues(html, "og:image")
				.map((value) => resolveUrl(value, base))
				.filter(
					(candidate): candidate is URL =>
						candidate !== undefined &&
						candidate.href !== pageUrl.href &&
						candidate.href !== base.href,
				)
				.map((candidate) => candidate.href),
		),
	].slice(0, MAX_GALLERY_IMAGES);
	const media: EmbedMedia[] | undefined =
		galleryUrls.length > 1
			? galleryUrls.map((url, index) =>
					index === 0 && image ? { kind: "image", ...image } : { kind: "image", url },
				)
			: undefined;

	const themeColor = parseThemeColor(get("theme-color"));
	const layout = LAYOUTS[get("twitter:card")?.toLowerCase() ?? ""];
	const publishedAt = parsePublishedAt(get("article:published_time"));
	const icon = pickIconUrl(extractLinkTags(html), base);
	const provider: EmbedProvider | undefined =
		icon && siteName ? { name: siteName, icon } : undefined;

	return {
		uri,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(siteName ? { siteName } : {}),
		...(image ? { image } : {}),
		...(video ? { video } : {}),
		...(themeColor ? { themeColor } : {}),
		...(layout ? { layout } : {}),
		...(provider ? { provider } : {}),
		...(publishedAt ? { publishedAt } : {}),
		...(media ? { media } : {}),
	};
}

async function enrichFromLinks(
	embed: LinkEmbed,
	html: string,
	base: URL,
	options: LinkPreviewOptions,
): Promise<LinkEmbed> {
	const links = extractLinkTags(html);
	const fetchOptions = {
		timeoutMs: options.timeoutMs,
		dispatcher: options.dispatcher,
		resolveHost: options.resolveHost,
	};
	const oEmbedUrl = findOEmbedUrl(links, base);
	const statusUrl = findStatusApiUrl(links, base);
	const [oEmbed, activity] = await Promise.all([
		oEmbedUrl ? fetchOEmbed(oEmbedUrl, fetchOptions) : undefined,
		statusUrl ? fetchActivityPost(statusUrl, fetchOptions) : undefined,
	]);

	let enriched = embed;
	if (oEmbed) {
		const provider = oEmbed.provider
			? {
					...oEmbed.provider,
					...(embed.provider?.icon ? { icon: embed.provider.icon } : {}),
				}
			: embed.provider;
		enriched = {
			...enriched,
			...(provider ? { provider } : {}),
			...(oEmbed.author ? { author: oEmbed.author } : {}),
			...(oEmbed.text && !embed.description ? { description: oEmbed.text } : {}),
		};
	}
	if (activity) {
		enriched = {
			...enriched,
			author: activity.author,
			post: activity.post,
			...(activity.publishedAt ? { publishedAt: activity.publishedAt } : {}),
			...(activity.media.length > 0 ? { media: activity.media } : {}),
		};
		delete enriched.description;
		if (activity.media.length > 0) {
			delete enriched.image;
			delete enriched.video;
		}
	}
	return enriched;
}

async function withMeasuredImage(
	embed: LinkEmbed,
	measureImage: ImageMeasurer | undefined,
): Promise<LinkEmbed> {
	const image = embed.image;
	if (!measureImage || !image) return embed;
	if (image.width !== undefined && image.height !== undefined) return embed;

	let measured: MeasuredImage | undefined;
	try {
		measured = await measureImage(image.url);
	} catch {
		return embed;
	}
	if (!measured) return embed;

	const size = { width: measured.width, height: measured.height };
	const media =
		embed.media?.length === 1 && embed.media[0]?.url === image.url
			? [{ ...embed.media[0], ...size }]
			: embed.media;
	return {
		...embed,
		image: { ...image, ...size },
		...(media ? { media } : {}),
	};
}

export function imageLinkEmbed(uri: string, url: URL, mimeType: LinkedImageType): LinkEmbed {
	return {
		uri,
		image: { url: url.href },
		media: [{ kind: "image", url: url.href, mimeType }],
	};
}

type PageFetch = {
	pageUrl: string;
	headers?: Record<string, string>;
};

async function fetchOpenGraphPreview(
	rawUrl: string,
	page: PageFetch,
	options: LinkPreviewOptions,
): Promise<{ embed: LinkEmbed; finalUrl: URL; html: string }> {
	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(page.pageUrl, {
			headers: { accept: HTML_ACCEPT, ...page.headers },
			timeoutMs: options.timeoutMs,
			maxRedirects: options.maxRedirects,
			maxResponseBytes: options.maxBytes ?? DEFAULT_MAX_HEAD_BYTES,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
			stopStreaming: containsHeadClose,
		});
	} catch (cause) {
		if (isEmbedError(cause)) throw cause;
		throw notFetchable(`fetching '${rawUrl}' failed`, cause);
	}

	if (result.statusCode < 200 || result.statusCode >= 300) {
		throw upstreamFailure(`upstream returned status ${result.statusCode}`);
	}

	const imageType = linkedImageType(result.headers["content-type"]);
	if (imageType) {
		return { embed: imageLinkEmbed(rawUrl, result.url, imageType), finalUrl: result.url, html: "" };
	}

	const html = result.body.toString("utf8");
	return { embed: extractLinkMetadata(rawUrl, html, result.url), finalUrl: result.url, html };
}

async function fetchYouTubePreview(
	rawUrl: string,
	link: YouTubeLink,
	options: LinkPreviewOptions,
): Promise<LinkEmbed> {
	const fromOEmbed = await fetchYouTubeOEmbed(rawUrl, link, options);
	if (fromOEmbed) return fromOEmbed;

	const { embed, finalUrl } = await fetchOpenGraphPreview(
		rawUrl,
		{ pageUrl: youtubeFallbackPageUrl(link), headers: { cookie: YOUTUBE_CONSENT_COOKIE } },
		options,
	);
	if (isYouTubeConsentPage(embed, finalUrl)) {
		throw upstreamFailure("YouTube answered with its consent page");
	}
	return { ...embed, siteName: YOUTUBE_SITE_NAME };
}

async function fetchGenericPreview(
	rawUrl: string,
	options: LinkPreviewOptions,
): Promise<LinkEmbed> {
	const xStatus = parseXStatusUrl(rawUrl);
	if (xStatus) {
		const embed = await fetchXStatusPreview(rawUrl, xStatus, options);
		if (embed) return embed;
	}
	const { embed, finalUrl, html } = await fetchOpenGraphPreview(
		rawUrl,
		{ pageUrl: rawUrl },
		options,
	);
	return enrichFromLinks(embed, html, finalUrl, options);
}

export async function fetchLinkPreview(
	rawUrl: string,
	options: LinkPreviewOptions = {},
): Promise<LinkEmbed> {
	const cache =
		options.cache === null ? undefined : (options.cache ?? resolveDefaultPreviewCache());
	const cacheKey = cache ? normalizeUrlCacheKey(rawUrl) : undefined;

	if (cache && cacheKey) {
		const cached = cache.get(cacheKey);
		if (cached) return cached;
	}

	const youtube = parseYouTubeUrl(rawUrl);
	const extracted = youtube
		? await fetchYouTubePreview(rawUrl, youtube, options)
		: await fetchGenericPreview(rawUrl, options);
	const embed = await withMeasuredImage(extracted, options.measureImage);

	if (cache && cacheKey) cache.set(cacheKey, embed);
	return embed;
}
