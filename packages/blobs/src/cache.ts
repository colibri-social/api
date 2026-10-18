import { LRUCache } from "lru-cache";
import type { Variant } from "./variants.js";

export const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export type BlobCacheEntry = {
	bytes: Uint8Array;
	mimeType: string;
};

export type BlobCacheKey = {
	did: string;
	space?: string;
	cid: string;
	variant?: Variant;
};

export const blobCacheKey = ({ did, space, cid, variant }: BlobCacheKey): string =>
	[did, space ?? "", cid, variant ?? ""].join(" ");

export type BlobCacheOptions = {
	maxBytes?: number;
	maxEntryBytes?: number;
};

export type BlobCacheStats = {
	hits: number;
	misses: number;
};

export class BlobCache {
	readonly maxEntryBytes: number;
	private readonly store: LRUCache<string, BlobCacheEntry>;
	private hitCount = 0;
	private missCount = 0;

	constructor(options: BlobCacheOptions = {}) {
		const maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
		this.maxEntryBytes = Math.min(options.maxEntryBytes ?? DEFAULT_CACHE_MAX_ENTRY_BYTES, maxBytes);
		this.store = new LRUCache<string, BlobCacheEntry>({
			maxSize: maxBytes,
			maxEntrySize: this.maxEntryBytes,
			sizeCalculation: (entry) => Math.max(entry.bytes.byteLength, 1),
		});
	}

	get(key: BlobCacheKey): BlobCacheEntry | undefined {
		const entry = this.store.get(blobCacheKey(key));
		if (entry) this.hitCount += 1;
		else this.missCount += 1;
		return entry;
	}

	set(key: BlobCacheKey, entry: BlobCacheEntry): void {
		if (entry.bytes.byteLength > this.maxEntryBytes) return;
		this.store.set(blobCacheKey(key), entry);
	}

	get stats(): BlobCacheStats {
		return { hits: this.hitCount, misses: this.missCount };
	}
}
