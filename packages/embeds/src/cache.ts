import { LRUCache } from "lru-cache";

export type TtlCacheOptions = {
	maxEntries?: number;
	ttlMs?: number;
};

export type TtlCache<T extends {}> = {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	delete(key: string): void;
	clear(): void;
	readonly size: number;
};

export const DEFAULT_PREVIEW_CACHE_MAX_ENTRIES = 1000;
export const DEFAULT_PREVIEW_CACHE_TTL_MS = 60 * 60 * 1000;

export const DEFAULT_GIF_CACHE_MAX_ENTRIES = 500;
export const DEFAULT_GIF_CACHE_TTL_MS = 10 * 60 * 1000;

export function createTtlCache<T extends {}>(options: TtlCacheOptions = {}): TtlCache<T> {
	const cache = new LRUCache<string, T>({
		max: options.maxEntries ?? DEFAULT_PREVIEW_CACHE_MAX_ENTRIES,
		ttl: options.ttlMs ?? DEFAULT_PREVIEW_CACHE_TTL_MS,
	});

	return {
		get: (key) => cache.get(key),
		set: (key, value) => {
			cache.set(key, value);
		},
		delete: (key) => {
			cache.delete(key);
		},
		clear: () => {
			cache.clear();
		},
		get size() {
			return cache.size;
		},
	};
}

export function createPreviewCache<T extends {}>(options: TtlCacheOptions = {}): TtlCache<T> {
	return createTtlCache<T>({
		maxEntries: options.maxEntries ?? DEFAULT_PREVIEW_CACHE_MAX_ENTRIES,
		ttlMs: options.ttlMs ?? DEFAULT_PREVIEW_CACHE_TTL_MS,
	});
}

export function createGifCache<T extends {}>(options: TtlCacheOptions = {}): TtlCache<T> {
	return createTtlCache<T>({
		maxEntries: options.maxEntries ?? DEFAULT_GIF_CACHE_MAX_ENTRIES,
		ttlMs: options.ttlMs ?? DEFAULT_GIF_CACHE_TTL_MS,
	});
}

export function normalizeUrlCacheKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.hash = "";
		return url.toString();
	} catch {
		return rawUrl;
	}
}
