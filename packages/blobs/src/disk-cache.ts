import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BlobCacheEntry, type BlobCacheKey, blobCacheKey } from "./cache.js";

export const DEFAULT_DISK_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;

const HEADER_END = 0x0a;

const FILE_PATTERN = /^[0-9a-f]{64}$/;

export type DiskCacheOptions = {
	directory: string;
	maxBytes?: number;
};

export type DiskCacheStats = {
	files: number;
	bytes: number;
	hits: number;
	misses: number;
};

type IndexEntry = {
	size: number;
};

export const diskCacheName = (key: BlobCacheKey): string => {
	return createHash("sha256").update(blobCacheKey(key)).digest("hex");
};

export class DiskVariantCache {
	private readonly directory: string;
	private readonly maxBytes: number;
	private readonly index = new Map<string, IndexEntry>();
	private total = 0;
	private hits = 0;
	private misses = 0;
	private loaded: Promise<void> | null = null;

	constructor(options: DiskCacheOptions) {
		this.directory = options.directory;
		this.maxBytes = options.maxBytes ?? DEFAULT_DISK_CACHE_MAX_BYTES;
	}

	get stats(): DiskCacheStats {
		return { files: this.index.size, bytes: this.total, hits: this.hits, misses: this.misses };
	}

	load(): Promise<void> {
		this.loaded ??= this.scan();

		return this.loaded;
	}

	async get(key: BlobCacheKey): Promise<BlobCacheEntry | undefined> {
		await this.load();

		const name = diskCacheName(key);
		const known = this.index.get(name);

		if (!known) {
			this.misses += 1;

			return undefined;
		}

		const file = await readFile(this.pathOf(name)).catch(() => null);
		const entry = file ? decode(file) : null;

		if (!entry) {
			this.forget(name);
			this.misses += 1;

			return undefined;
		}

		this.index.delete(name);
		this.index.set(name, known);
		this.hits += 1;

		const now = new Date();

		void utimes(this.pathOf(name), now, now).catch(() => undefined);

		return entry;
	}

	async set(key: BlobCacheKey, entry: BlobCacheEntry): Promise<void> {
		await this.load();

		const encoded = encode(entry);

		if (encoded.byteLength > this.maxBytes) {
			return;
		}

		const name = diskCacheName(key);
		const target = this.pathOf(name);
		const temporary = `${target}.${randomUUID()}.tmp`;

		await mkdir(join(this.directory, name.slice(0, 2)), { recursive: true });
		await writeFile(temporary, encoded);
		await rename(temporary, target);

		this.forget(name);
		this.index.set(name, { size: encoded.byteLength });
		this.total += encoded.byteLength;
		await this.trim();
	}

	private pathOf(name: string): string {
		return join(this.directory, name.slice(0, 2), name);
	}

	private forget(name: string): void {
		const known = this.index.get(name);

		if (known) {
			this.total -= known.size;
			this.index.delete(name);
		}
	}

	private async trim(): Promise<void> {
		while (this.total > this.maxBytes) {
			const oldest = this.index.keys().next().value;

			if (oldest === undefined) {
				return;
			}

			this.forget(oldest);
			await rm(this.pathOf(oldest), { force: true });
		}
	}

	private async scan(): Promise<void> {
		await mkdir(this.directory, { recursive: true });

		const found: { name: string; size: number; used: number }[] = [];

		for (const prefix of await readdir(this.directory).catch(() => [])) {
			const folder = join(this.directory, prefix);
			const names = await readdir(folder).catch(() => []);

			for (const name of names) {
				const path = join(folder, name);

				if (!FILE_PATTERN.test(name)) {
					if (name.endsWith(".tmp")) await rm(path, { force: true });
					continue;
				}

				const info = await stat(path).catch(() => null);

				if (info?.isFile()) found.push({ name, size: info.size, used: info.mtimeMs });
			}
		}

		found.sort((a, b) => a.used - b.used);

		for (const file of found) {
			this.index.set(file.name, { size: file.size });
			this.total += file.size;
		}

		await this.trim();
	}
}

const encode = (entry: BlobCacheEntry): Uint8Array => {
	const header = Buffer.from(`${entry.mimeType}\n`, "utf8");
	const out = new Uint8Array(header.byteLength + entry.bytes.byteLength);

	out.set(header, 0);
	out.set(entry.bytes, header.byteLength);

	return out;
};

const decode = (file: Uint8Array): BlobCacheEntry | null => {
	const end = file.indexOf(HEADER_END);

	if (end <= 0 || end > 255) {
		return null;
	}

	return {
		mimeType: Buffer.from(file.subarray(0, end)).toString("utf8"),
		bytes: Uint8Array.from(file.subarray(end + 1)),
	};
};
