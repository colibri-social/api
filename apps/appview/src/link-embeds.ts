import { dimensionsOf } from "@colibri-social/blobs";
import {
	createImageMeasurer,
	fetchLinkPreview,
	type ImageMeasurer,
	isEmbedError,
	type LinkEmbed,
	normalizeUrlCacheKey,
	type TtlCache,
	videoTypeFromExtension,
} from "@colibri-social/embeds";
import type { Logger } from "./logger.js";

export const MAX_EMBEDS_PER_MESSAGE = 5;

export const PREVIEW_CACHE_MAX_ENTRIES = 5_000;

export const PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const MISS_TTL_MS = 5 * 60 * 1000;

const DIRECT_IMAGE = /\.(gif|webp|png|jpe?g|avif)$/i;

type RawFeature = { $type?: unknown; uri?: unknown };
type RawFacet = { features?: RawFeature[] };

export const linkUrisOf = (facets: unknown, suppressed: unknown): string[] => {
	const hidden = new Set(Array.isArray(suppressed) ? (suppressed as unknown[]) : []);
	const out: string[] = [];
	for (const facet of Array.isArray(facets) ? (facets as RawFacet[]) : []) {
		for (const feature of facet?.features ?? []) {
			const { $type, uri } = feature ?? {};
			if (typeof $type !== "string" || !$type.endsWith("#link")) continue;
			if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) continue;
			if (hidden.has(uri) || out.includes(uri)) continue;
			out.push(uri);
		}
	}
	return out.slice(0, MAX_EMBEDS_PER_MESSAGE);
};

export type LinkEmbedResolver = {
	peek(uri: string): LinkEmbed | undefined;
	resolve(uris: readonly string[], waitMs: number): Promise<Map<string, LinkEmbed>>;
	settle(uris: readonly string[]): Promise<void>;
};

export type LinkEmbedResolverOptions = {
	cache: TtlCache<LinkEmbed>;
	log: Logger;
	fetchPreview?: (uri: string, measureImage: ImageMeasurer) => Promise<LinkEmbed>;
	now?: () => number;
};

const directMediaEmbed = async (
	uri: string,
	measureImage: ImageMeasurer,
): Promise<LinkEmbed | undefined> => {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return undefined;
	}
	const mimeType = videoTypeFromExtension(url);
	if (mimeType) return { uri, video: { url: uri, mimeType } };
	if (!DIRECT_IMAGE.test(url.pathname)) return undefined;
	const measured = await measureImage(uri).catch(() => undefined);
	return { uri, image: { url: uri, ...(measured ?? {}) } };
};

const pause = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});

export const createLinkEmbedResolver = (options: LinkEmbedResolverOptions): LinkEmbedResolver => {
	const { cache, log } = options;
	const now = options.now ?? Date.now;
	const fetchPreview =
		options.fetchPreview ??
		((uri: string, measureImage: ImageMeasurer) =>
			fetchLinkPreview(uri, { cache: null, measureImage }));
	const measureImage = createImageMeasurer({
		decode: dimensionsOf,
		onMiss: (reason) => log.debug({ reason }, "embed.imageSizeUnknown"),
	});
	const missedUntil = new Map<string, number>();
	const inflight = new Map<string, Promise<void>>();

	const peek = (uri: string) => cache.get(normalizeUrlCacheKey(uri));

	const load = (uri: string): Promise<void> | undefined => {
		const key = normalizeUrlCacheKey(uri);
		const running = inflight.get(key);
		if (running) return running;
		const until = missedUntil.get(key);
		if (until !== undefined) {
			if (until > now()) return undefined;
			missedUntil.delete(key);
		}

		const loading = (async () => {
			try {
				const embed =
					(await directMediaEmbed(uri, measureImage)) ?? (await fetchPreview(uri, measureImage));
				cache.set(key, embed);
			} catch (error) {
				missedUntil.set(key, now() + MISS_TTL_MS);
				const code = isEmbedError(error) ? error.code : "UnfurlFailed";
				log.debug({ uri, code, err: error }, "embed.unfurlFailed");
			} finally {
				inflight.delete(key);
			}
		})();
		inflight.set(key, loading);
		return loading;
	};

	const resolve = async (uris: readonly string[], waitMs: number) => {
		const found = new Map<string, LinkEmbed>();
		const waiting: Promise<void>[] = [];
		for (const uri of new Set(uris)) {
			const hit = peek(uri);
			if (hit) {
				found.set(uri, hit);
				continue;
			}
			const loading = load(uri);
			if (loading) waiting.push(loading);
		}
		if (waiting.length === 0 || waitMs <= 0) return found;

		await Promise.race([Promise.all(waiting), pause(waitMs)]);
		for (const uri of uris) {
			if (found.has(uri)) continue;
			const hit = peek(uri);
			if (hit) found.set(uri, hit);
		}
		return found;
	};

	const settle = async (uris: readonly string[]) => {
		const waiting = uris
			.map((uri) => inflight.get(normalizeUrlCacheKey(uri)))
			.filter((loading): loading is Promise<void> => loading !== undefined);
		await Promise.all(waiting);
	};

	return { peek, resolve, settle };
};
