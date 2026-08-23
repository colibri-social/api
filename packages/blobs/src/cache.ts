import { LRUCache } from "lru-cache";
import type { Variant } from "./variants.js";

export const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export type BlobCacheEntry = {
	bytes: Uint8Array;
	mimeType: string;
};

export type BlobCacheKey = {
	cid: string;
	variant?: Variant;
};

export const blobCacheKey = ({ cid, variant }: BlobCacheKey): string =>
	variant ? `${cid}@${variant}` : cid;

export type BlobCacheOptions = {
	maxBytes?: number;
};

export type BlobCacheStats = {
	hits: number;
	misses: number;
};

export class BlobCache {
	private readonly store: LRUCache<string, BlobCacheEntry>;
	private hitCount = 0;
	private missCount = 0;

	constructor(options: BlobCacheOptions = {}) {
		this.store = new LRUCache<string, BlobCacheEntry>({
			maxSize: options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
			sizeCalculation: (entry) => entry.bytes.byteLength,
		});
	}

	get(key: BlobCacheKey): BlobCacheEntry | undefined {
		const entry = this.store.get(blobCacheKey(key));
		if (entry) this.hitCount += 1;
		else this.missCount += 1;
		return entry;
	}

	set(key: BlobCacheKey, entry: BlobCacheEntry): void {
		this.store.set(blobCacheKey(key), entry);
	}

	get stats(): BlobCacheStats {
		return { hits: this.hitCount, misses: this.missCount };
	}
}
