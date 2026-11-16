import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { BlobCacheKey } from "./cache.js";
import { diskCacheName } from "./disk-cache.js";

export const DEFAULT_DISK_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const HEADER_END = 0x0a;

const HEADER_MAX_BYTES = 256;

const READ_CHUNK_BYTES = 64 * 1024;

const FILE_PATTERN = /^[0-9a-f]{64}$/;

export type DiskOriginalCacheOptions = {
	directory: string;
	maxBytes?: number;
};

export type DiskOriginalStats = {
	files: number;
	bytes: number;
	hits: number;
	misses: number;
	filling: number;
};

export type DiskOriginal = {
	mimeType: string;
	size: number | null;
	settled: () => Promise<number>;
	read: (start: number, end: number | null) => AsyncIterable<Uint8Array>;
};

type IndexEntry = {
	size: number;
};

type Header = {
	mimeType: string;
	bytes: number;
};

type FillTarget = {
	ready: Promise<void>;
	folder: string;
	temporary: string;
	target: string;
	maxBytes: number;
	onStored: (fileBytes: number) => Promise<void>;
	onSettled: () => void;
};

async function* readRange(
	path: string,
	start: number,
	end: number | undefined,
): AsyncGenerator<Uint8Array, void, unknown> {
	const stream = createReadStream(path, end === undefined ? { start } : { start, end });

	for await (const chunk of stream) {
		yield chunk as Buffer;
	}
}

const discard = async (source: AsyncIterable<Uint8Array>): Promise<void> => {
	const iterator = source[Symbol.asyncIterator]();

	await iterator.next().catch(() => undefined);
	await iterator.return?.().catch(() => undefined);
};

const encodeHeader = (mimeType: string): Uint8Array => {
	return Buffer.from(`${mimeType}\n`, "utf8");
};

const readHeader = async (path: string): Promise<Header | null> => {
	const handle = await open(path, "r").catch(() => null);

	if (!handle) {
		return null;
	}

	try {
		const buffer = new Uint8Array(HEADER_MAX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_MAX_BYTES, 0);
		const end = buffer.subarray(0, bytesRead).indexOf(HEADER_END);

		if (end <= 0) {
			return null;
		}

		return {
			mimeType: Buffer.from(buffer.subarray(0, end)).toString("utf8"),
			bytes: end + 1,
		};
	} finally {
		await handle.close().catch(() => undefined);
	}
};

class OriginalFill implements DiskOriginal {
	private readonly header: Uint8Array;
	private readonly target: FillTarget;
	private handle: FileHandle | null = null;
	private written = 0;
	private failure: { error: unknown } | null = null;
	private complete = false;
	private pumping = true;
	private readers = 0;
	private waiters: (() => void)[] = [];

	readonly mimeType: string;
	readonly size: number | null;
	readonly finished: Promise<number>;

	constructor(
		mimeType: string,
		size: number | null,
		source: AsyncIterable<Uint8Array>,
		target: FillTarget,
	) {
		this.mimeType = mimeType;
		this.size = size;
		this.header = encodeHeader(mimeType);
		this.target = target;
		this.finished = this.pump(source);
		this.finished.catch(() => undefined);
	}

	settled(): Promise<number> {
		return this.finished;
	}

	async *read(start: number, end: number | null): AsyncGenerator<Uint8Array, void, unknown> {
		this.readers += 1;

		try {
			let position = start;

			while (end === null || position <= end) {
				while (position >= this.written && !this.complete && !this.failure) {
					await this.change();
				}

				if (this.failure) {
					throw this.failure.error;
				}

				if (position >= this.written) {
					return;
				}

				const handle = this.handle;

				if (!handle) {
					yield* readRange(
						this.target.target,
						this.header.byteLength + position,
						end === null ? undefined : this.header.byteLength + end,
					);

					return;
				}

				const stop = end === null ? this.written : Math.min(this.written, end + 1);
				const length = Math.min(stop - position, READ_CHUNK_BYTES);
				const buffer = new Uint8Array(length);
				const { bytesRead } = await handle.read(
					buffer,
					0,
					length,
					this.header.byteLength + position,
				);

				if (bytesRead === 0) {
					throw new Error("the cached blob ended early");
				}

				position += bytesRead;

				yield buffer.subarray(0, bytesRead);
			}
		} finally {
			this.readers -= 1;
			await this.closeIfIdle();
		}
	}

	private change(): Promise<void> {
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	private notify(): void {
		const waiting = this.waiters;

		this.waiters = [];

		for (const wake of waiting) wake();
	}

	private async closeIfIdle(): Promise<void> {
		if (this.pumping || this.readers > 0 || !this.handle) {
			return;
		}

		const handle = this.handle;

		this.handle = null;
		await handle.close().catch(() => undefined);
	}

	private async pump(source: AsyncIterable<Uint8Array>): Promise<number> {
		let started = false;

		try {
			await this.target.ready;
			await mkdir(this.target.folder, { recursive: true });

			const handle = await open(this.target.temporary, "wx+");

			this.handle = handle;
			await handle.write(this.header, 0, this.header.byteLength, 0);

			started = true;

			for await (const chunk of source) {
				await handle.write(chunk, 0, chunk.byteLength, this.header.byteLength + this.written);
				this.written += chunk.byteLength;
				this.notify();
			}

			const fileBytes = this.header.byteLength + this.written;

			if (fileBytes > this.target.maxBytes) {
				await rm(this.target.temporary, { force: true });
			} else {
				await rename(this.target.temporary, this.target.target);
				await this.target.onStored(fileBytes);
			}

			this.complete = true;

			return this.written;
		} catch (error) {
			this.failure = { error };

			if (!started) await discard(source);

			await rm(this.target.temporary, { force: true });

			throw error;
		} finally {
			this.pumping = false;
			this.target.onSettled();
			this.notify();
			await this.closeIfIdle();
		}
	}
}

export class DiskOriginalCache {
	private readonly directory: string;
	private readonly maxBytes: number;
	private readonly index = new Map<string, IndexEntry>();
	private readonly fills = new Map<string, OriginalFill>();
	private total = 0;
	private hits = 0;
	private misses = 0;
	private loaded: Promise<void> | null = null;

	constructor(options: DiskOriginalCacheOptions) {
		this.directory = options.directory;
		this.maxBytes = options.maxBytes ?? DEFAULT_DISK_ORIGINAL_MAX_BYTES;
	}

	get stats(): DiskOriginalStats {
		return {
			files: this.index.size,
			bytes: this.total,
			hits: this.hits,
			misses: this.misses,
			filling: this.fills.size,
		};
	}

	load(): Promise<void> {
		this.loaded ??= this.scan();

		return this.loaded;
	}

	filling(key: BlobCacheKey): DiskOriginal | undefined {
		return this.fills.get(diskCacheName(key));
	}

	async open(key: BlobCacheKey): Promise<DiskOriginal | undefined> {
		await this.load();

		const name = diskCacheName(key);
		const known = this.index.get(name);

		if (!known) {
			this.misses += 1;

			return undefined;
		}

		const path = this.pathOf(name);
		const header = await readHeader(path);

		if (!header || known.size < header.bytes) {
			this.forget(name);
			this.misses += 1;
			await rm(path, { force: true });

			return undefined;
		}

		this.index.delete(name);
		this.index.set(name, known);
		this.hits += 1;

		const now = new Date();

		void utimes(path, now, now).catch(() => undefined);

		const size = known.size - header.bytes;

		return {
			mimeType: header.mimeType,
			size,
			settled: async () => {
				return size;
			},
			read: (start, end) => {
				return readRange(path, header.bytes + start, end === null ? undefined : header.bytes + end);
			},
		};
	}

	fill(
		key: BlobCacheKey,
		mimeType: string,
		declaredSize: number | null,
		source: () => AsyncIterable<Uint8Array>,
	): DiskOriginal | null {
		const name = diskCacheName(key);
		const headerBytes = encodeHeader(mimeType).byteLength;

		if (this.fills.has(name) || headerBytes > HEADER_MAX_BYTES) {
			return null;
		}

		if (declaredSize !== null && headerBytes + declaredSize > this.maxBytes) {
			return null;
		}

		const target = this.pathOf(name);
		const fill = new OriginalFill(mimeType, declaredSize, source(), {
			ready: this.load(),
			folder: join(this.directory, name.slice(0, 2)),
			temporary: `${target}.${randomUUID()}.tmp`,
			target,
			maxBytes: this.maxBytes,
			onStored: async (fileBytes) => {
				this.forget(name);
				this.index.set(name, { size: fileBytes });
				this.total += fileBytes;
				await this.trim();
			},
			onSettled: () => {
				this.fills.delete(name);
			},
		});

		this.fills.set(name, fill);

		return fill;
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
