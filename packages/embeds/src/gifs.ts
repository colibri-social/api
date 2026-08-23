import { type Dispatcher, request } from "undici";
import type { TtlCache } from "./cache.js";
import { createGifCache } from "./cache.js";
import { upstreamFailure } from "./errors.js";
import type { GifCategory, GifPage, GifView } from "./types.js";

const KLIPY_BASE = "https://api.klipy.com/api/v1";
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const MEDIA_SIZES = ["md", "hd", "sm", "xs"] as const;
const PREVIEW_SIZES = ["sm", "xs", "md", "hd"] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const asObject = (value: Json | undefined): Record<string, Json> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

const asArray = (value: Json | undefined): Json[] | undefined =>
	Array.isArray(value) ? value : undefined;

const asString = (value: Json | undefined): string | undefined =>
	typeof value === "string" ? value : undefined;

const asNumber = (value: Json | undefined): number | undefined =>
	typeof value === "number" ? value : undefined;

type MediaVariant = { url: string; width?: number; height?: number };

function pickVariant(
	file: Json | undefined,
	sizes: readonly string[],
	format: string,
): MediaVariant | undefined {
	const fileObject = asObject(file);
	if (!fileObject) return undefined;

	for (const size of sizes) {
		const node = asObject(asObject(fileObject[size])?.[format]);
		const url = asString(node?.url);
		if (url) return { url, width: asNumber(node?.width), height: asNumber(node?.height) };
	}
	return undefined;
}

function normalizeItem(item: Json): GifView | undefined {
	const obj = asObject(item);
	if (!obj) return undefined;

	const rawId = asString(obj.slug) ?? asString(obj.id) ?? asNumber(obj.id);
	if (rawId === undefined) return undefined;
	const id = String(rawId);

	const file = obj.file;
	const media = pickVariant(file, MEDIA_SIZES, "gif") ?? pickVariant(file, MEDIA_SIZES, "webp");
	const mediaUrl = media?.url ?? asString(obj.url);
	if (!mediaUrl) return undefined;

	if (media?.width === undefined || media?.height === undefined) return undefined;

	const preview =
		pickVariant(file, PREVIEW_SIZES, "gif") ??
		pickVariant(file, PREVIEW_SIZES, "webp") ??
		pickVariant(file, PREVIEW_SIZES, "jpg");
	const previewUrl = preview?.url ?? mediaUrl;

	const title = asString(obj.title)?.trim();

	return {
		id,
		url: mediaUrl,
		previewUrl,
		width: media.width,
		height: media.height,
		...(title ? { title } : {}),
	};
}

function itemsArray(body: Json): Json[] {
	const data = asObject(body)?.data;
	const nested = asArray(asObject(data)?.data);
	if (nested) return nested;
	return asArray(data) ?? [];
}

function normalizePage(
	body: Json,
	requestedPage: number,
): { items: GifView[]; page: number; hasNext: boolean } {
	const items: GifView[] = [];
	for (const raw of itemsArray(body)) {
		const item = normalizeItem(raw);
		if (item) items.push(item);
	}

	const data = asObject(asObject(body)?.data);
	const page = asNumber(data?.current_page) ?? requestedPage;
	const hasNext = data?.has_next === true;

	return { items, page, hasNext };
}

function normalizeCategories(body: Json): GifCategory[] {
	const categories = asArray(asObject(asObject(body)?.data)?.categories) ?? [];
	const result: GifCategory[] = [];

	for (const raw of categories) {
		const obj = asObject(raw);
		if (!obj) continue;

		const name = asString(obj.category) ?? asString(obj.name) ?? asString(obj.title);
		if (!name) continue;

		const previewUrl = asString(obj.preview_url) ?? asString(obj.image);
		result.push(previewUrl ? { name, previewUrl } : { name });
	}

	return result;
}

function toGifPage(page: { items: GifView[]; page: number; hasNext: boolean }): GifPage {
	return { gifs: page.items, ...(page.hasNext ? { cursor: String(page.page + 1) } : {}) };
}

async function getJson(
	apiKey: string,
	resource: string,
	path: string,
	query: Record<string, string>,
	options: { timeoutMs: number; dispatcher?: Dispatcher },
): Promise<Json> {
	let url: URL;
	try {
		url = new URL(`${KLIPY_BASE}/${apiKey}/${resource}/${path}`);
	} catch (cause) {
		throw upstreamFailure("could not build the klipy request url", cause);
	}
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

	let response: Dispatcher.ResponseData;
	try {
		response = await request(url, {
			method: "GET",
			dispatcher: options.dispatcher,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (cause) {
		throw upstreamFailure(`klipy request to '${resource}/${path}' failed`, cause);
	}

	if (response.statusCode < 200 || response.statusCode >= 300) {
		response.body.destroy();
		throw upstreamFailure(`klipy returned status ${response.statusCode}`);
	}

	try {
		return (await response.body.json()) as Json;
	} catch (cause) {
		throw upstreamFailure("klipy returned a response that was not valid json", cause);
	}
}

export type GifPageParams = {
	cursor?: string;
	limit?: number;
};

export type GifsClient = {
	searchGifs(query: string, params?: GifPageParams): Promise<GifPage>;
	trendingGifs(params?: GifPageParams): Promise<GifPage>;
	gifCategories(): Promise<GifCategory[]>;
};

export type GifsClientOptions = {
	apiKey?: string;
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	pageCache?: TtlCache<GifPage> | null;
	categoryCache?: TtlCache<GifCategory[]> | null;
};

const clampLimit = (limit: number | undefined): number =>
	Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

const parseCursor = (cursor: string | undefined): number => {
	if (!cursor) return 1;
	const page = Number.parseInt(cursor, 10);
	return Number.isFinite(page) && page > 0 ? page : 1;
};

export function createGifsClient(options: GifsClientOptions = {}): GifsClient | null {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) return null;

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const dispatcher = options.dispatcher;
	const pageCache =
		options.pageCache === null ? undefined : (options.pageCache ?? createGifCache<GifPage>());
	const categoryCache =
		options.categoryCache === null
			? undefined
			: (options.categoryCache ?? createGifCache<GifCategory[]>());

	const searchGifs = async (query: string, params: GifPageParams = {}): Promise<GifPage> => {
		const page = parseCursor(params.cursor);
		const limit = clampLimit(params.limit);
		const cacheKey = `search:${query}:${page}:${limit}`;

		const cached = pageCache?.get(cacheKey);
		if (cached) return cached;

		const body = await getJson(
			apiKey,
			"gifs",
			"search",
			{ q: query, page: String(page), per_page: String(limit) },
			{ timeoutMs, dispatcher },
		);
		const result = toGifPage(normalizePage(body, page));
		pageCache?.set(cacheKey, result);
		return result;
	};

	const trendingGifs = async (params: GifPageParams = {}): Promise<GifPage> => {
		const page = parseCursor(params.cursor);
		const limit = clampLimit(params.limit);
		const cacheKey = `trending:${page}:${limit}`;

		const cached = pageCache?.get(cacheKey);
		if (cached) return cached;

		const body = await getJson(
			apiKey,
			"gifs",
			"trending",
			{ page: String(page), per_page: String(limit) },
			{ timeoutMs, dispatcher },
		);
		const result = toGifPage(normalizePage(body, page));
		pageCache?.set(cacheKey, result);
		return result;
	};

	const gifCategories = async (): Promise<GifCategory[]> => {
		const cacheKey = "categories";
		const cached = categoryCache?.get(cacheKey);
		if (cached) return cached;

		const body = await getJson(apiKey, "gifs", "categories", {}, { timeoutMs, dispatcher });
		const result = normalizeCategories(body);
		categoryCache?.set(cacheKey, result);
		return result;
	};

	return { searchGifs, trendingGifs, gifCategories };
}
