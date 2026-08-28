import type { Dispatcher } from "undici";
import type { TtlCache } from "./cache.js";
import { createPreviewCache, normalizeUrlCacheKey } from "./cache.js";
import { isEmbedError, notFetchable, upstreamFailure } from "./errors.js";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";
import { containsHeadClose, extractMetaTags, extractTitleTag } from "./html.js";
import type { ImageMeasurer } from "./image.js";
import type { EmbedImage, EmbedVideo, LinkEmbed, MeasuredImage } from "./types.js";
import { type PlayableVideoType, playableVideoType, videoTypeFromExtension } from "./video.js";

const DEFAULT_MAX_HEAD_BYTES = 1024 * 1024;

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

	return {
		uri,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(siteName ? { siteName } : {}),
		...(image ? { image } : {}),
		...(video ? { video } : {}),
	};
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

	return { ...embed, image: { ...image, width: measured.width, height: measured.height } };
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

	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(rawUrl, {
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

	const html = result.body.toString("utf8");
	const extracted = extractLinkMetadata(rawUrl, html, result.url);
	const embed = await withMeasuredImage(extracted, options.measureImage);

	if (cache && cacheKey) cache.set(cacheKey, embed);
	return embed;
}
