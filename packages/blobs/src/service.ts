import { availableParallelism } from "node:os";
import type { SpaceClient, SpaceHostResolver, SpaceRefString } from "@colibri-social/space";
import { XrpcError } from "@colibri-social/space";
import type { BlobCacheEntry } from "./cache.js";
import { BlobCache, blobCacheKey } from "./cache.js";
import type { DiskVariantCache } from "./disk-cache.js";
import { BlobNotFoundError, BlobRejectedError, BlobUpstreamError } from "./errors.js";
import { isDownloadMimeType, sniffServedType } from "./mime.js";
import { applyRange, parseRange } from "./range.js";
import type { Variant } from "./variants.js";
import { renderVariant } from "./variants.js";
import { verifyingStream } from "./verify.js";

export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;

export type BlobFetchParams = {
	did: string;
	cid: string;
	space?: SpaceRefString;
	variant?: Variant;
	range?: string | null;
};

export type BlobRangeInfo = {
	start: number;
	end: number;
};

export type BlobResult =
	| {
			status: "ok";
			bytes: Uint8Array;
			mimeType: string;
			totalSize: number;
			range?: BlobRangeInfo;
	  }
	| {
			status: "stream";
			stream: AsyncIterable<Uint8Array>;
			mimeType: string;
			totalSize: number | null;
			length: number | null;
			range?: BlobRangeInfo;
	  }
	| {
			status: "rangeNotSatisfiable";
			totalSize: number;
	  };

export type PolyfilledBlob = {
	stream: AsyncIterable<Uint8Array>;
	size: number | null;
};

export type PolyfillBlobSource = {
	open: (did: string, cid: string) => Promise<PolyfilledBlob | null>;
	hosts?: (did: string, space: SpaceRefString) => Promise<boolean>;
};

export type BlobServiceOptions = {
	spaceClient: SpaceClient;
	polyfill?: PolyfillBlobSource;
	hosts: SpaceHostResolver;
	cache?: BlobCache;
	disk?: DiskVariantCache;
	renderConcurrency?: number;
	fetch?: typeof globalThis.fetch;
	maxBlobBytes?: number;
};

type OriginalKey = { did: string; cid: string; space: SpaceRefString | undefined };

type StreamedOriginal = {
	kind: "stream";
	head: Uint8Array;
	rest: AsyncIterator<Uint8Array>;
	mimeType: string;
	declaredSize: number | null;
};

type Original = { kind: "bytes"; entry: BlobCacheEntry } | StreamedOriginal;

type Upstream = {
	stream: AsyncIterable<Uint8Array>;
	declaredSize: number | null;
	cancel: () => Promise<void>;
};

const streamOf = (response: Response): AsyncIterable<Uint8Array> => {
	const body = response.body;
	if (!body) return (async function* () {})();
	return (async function* () {
		const reader = body.getReader();
		let finished = false;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					finished = true;
					return;
				}
				if (value) yield value;
			}
		} finally {
			if (!finished) await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	})();
};

async function* capped(
	source: AsyncIterable<Uint8Array>,
	maxBytes: number,
): AsyncGenerator<Uint8Array, void, unknown> {
	let total = 0;
	for await (const chunk of source) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new BlobRejectedError("tooLarge");
		yield chunk;
	}
}

async function* resumed(
	head: Uint8Array,
	rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array, void, unknown> {
	let completed = false;
	try {
		if (head.byteLength > 0) yield head;
		while (true) {
			const next = await rest.next();
			if (next.done) {
				completed = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (!completed) await rest.return?.();
	}
}

async function* sliced(
	source: AsyncIterable<Uint8Array>,
	start: number,
	end: number,
): AsyncGenerator<Uint8Array, void, unknown> {
	let offset = 0;
	let held: Uint8Array | null = null;
	for await (const chunk of source) {
		const chunkStart = offset;
		offset += chunk.byteLength;
		const from = Math.max(start - chunkStart, 0);
		const to = Math.min(end + 1 - chunkStart, chunk.byteLength);
		if (to <= from) continue;
		if (held) yield held;
		held = chunk.subarray(from, to);
	}
	if (held) yield held;
}

const concatBytes = (chunks: Uint8Array[], total: number): Uint8Array => {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

const declaredSizeOf = (response: Response): number | null => {
	const raw = response.headers.get("content-length");
	if (raw === null || !/^\d+$/.test(raw)) return null;
	const size = Number(raw);
	return Number.isSafeInteger(size) ? size : null;
};

const upstreamOf = (response: Response): Upstream => {
	return {
		stream: streamOf(response),
		declaredSize: declaredSizeOf(response),
		cancel: async () => {
			await response.body?.cancel().catch(() => undefined);
		},
	};
};

const upstreamOfPolyfill = (blob: PolyfilledBlob): Upstream => {
	return {
		stream: blob.stream,
		declaredSize: blob.size,
		cancel: async () => {
			await blob.stream[Symbol.asyncIterator]()
				.return?.()
				.catch(() => undefined);
		},
	};
};

const shareable = (): {
	promise: Promise<BlobCacheEntry | null>;
	resolve: (entry: BlobCacheEntry | null) => void;
	reject: (error: unknown) => void;
} => {
	let resolve: (entry: BlobCacheEntry | null) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<BlobCacheEntry | null>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	promise.catch(() => undefined);
	return { promise, resolve, reject };
};

export class BlobService {
	private readonly spaceClient: SpaceClient;
	private readonly hosts: SpaceHostResolver;
	private readonly polyfill: PolyfillBlobSource | undefined;
	private readonly cache: BlobCache;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly maxBlobBytes: number;
	private readonly inflight = new Map<string, Promise<BlobCacheEntry | null>>();
	private readonly rendering = new Map<string, Promise<BlobCacheEntry>>();
	private readonly renderWaiters: (() => void)[] = [];
	private readonly disk: DiskVariantCache | undefined;
	private readonly renderConcurrency: number;
	private renders = 0;

	constructor(options: BlobServiceOptions) {
		this.disk = options.disk;
		this.renderConcurrency =
			options.renderConcurrency ?? Math.max(1, Math.floor(availableParallelism() / 2));
		this.spaceClient = options.spaceClient;
		this.hosts = options.hosts;
		this.polyfill = options.polyfill;
		this.cache = options.cache ?? new BlobCache();
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
	}

	async fetch(params: BlobFetchParams): Promise<BlobResult> {
		const variant = params.variant ?? "full";
		const key: OriginalKey = { did: params.did, cid: params.cid, space: params.space };
		const cached = this.cache.get({ ...key, variant });
		if (cached) return toBlobResult(cached, params.range);

		if (variant !== "full" && this.disk) {
			const stored = await this.disk.get({ ...key, variant }).catch(() => undefined);

			if (stored) {
				this.cache.set({ ...key, variant }, stored);

				return toBlobResult(stored, params.range);
			}
		}

		const original = await this.original(key, variant !== "full", params.range ?? null);
		if (original.kind === "stream") return toStreamResult(original, params.range ?? null);
		if (variant === "full") return toBlobResult(original.entry, params.range);
		if (isDownloadMimeType(original.entry.mimeType)) {
			throw new BlobRejectedError("mimeNotAllowed", "this blob has no previews");
		}

		const entry = await this.render(key, variant, original.entry);

		return toBlobResult(entry, params.range);
	}

	private render(
		key: OriginalKey,
		variant: Variant,
		original: BlobCacheEntry,
	): Promise<BlobCacheEntry> {
		const id = blobCacheKey({ ...key, variant });
		const pending = this.rendering.get(id);

		if (pending) {
			return pending;
		}

		const work = (async () => {
			await this.renderSlot();

			try {
				const rendered = await renderVariant(original.bytes, original.mimeType, variant);
				const entry: BlobCacheEntry = { bytes: rendered.bytes, mimeType: rendered.mimeType };

				this.cache.set({ ...key, variant }, entry);
				void this.disk?.set({ ...key, variant }, entry).catch(() => undefined);

				return entry;
			} finally {
				this.renders -= 1;
				this.renderWaiters.shift()?.();
			}
		})();

		this.rendering.set(id, work);
		void work.finally(() => this.rendering.delete(id)).catch(() => undefined);

		return work;
	}

	private renderSlot(): Promise<void> {
		if (this.renders < this.renderConcurrency) {
			this.renders += 1;

			return Promise.resolve();
		}

		return new Promise((resolve) => {
			this.renderWaiters.push(() => {
				this.renders += 1;
				resolve();
			});
		});
	}

	private async original(
		key: OriginalKey,
		needsBytes: boolean,
		range: string | null,
	): Promise<Original> {
		const cachedOriginal = this.cache.get({ ...key, variant: "full" });
		if (cachedOriginal) return { kind: "bytes", entry: cachedOriginal };

		const id = blobCacheKey(key);
		const pending = this.inflight.get(id);
		if (pending) {
			const shared = await pending;
			if (shared) return { kind: "bytes", entry: shared };
			return this.load(key, needsBytes, range);
		}

		const shared = shareable();
		this.inflight.set(id, shared.promise);
		try {
			const original = await this.load(key, needsBytes, range);
			shared.resolve(original.kind === "bytes" ? original.entry : null);
			return original;
		} catch (error) {
			shared.reject(error);
			throw error;
		} finally {
			this.inflight.delete(id);
		}
	}

	private async load(
		key: OriginalKey,
		needsBytes: boolean,
		range: string | null,
	): Promise<Original> {
		const upstream = await this.fetchUpstream(key.did, key.cid, key.space);
		const declaredSize = upstream.declaredSize;
		if (declaredSize !== null && declaredSize > this.maxBlobBytes) {
			await upstream.cancel();
			throw new BlobRejectedError("tooLarge");
		}

		const buffers = needsBytes || (range !== null && declaredSize === null);
		const limit = buffers ? this.maxBlobBytes : this.cache.maxEntryBytes;
		const iterator = verifyingStream(capped(upstream.stream, this.maxBlobBytes), key.cid)[
			Symbol.asyncIterator
		]();

		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (total <= limit) {
				const next = await iterator.next();
				if (next.done) {
					const bytes = concatBytes(chunks, total);
					const entry: BlobCacheEntry = { bytes, mimeType: await sniffServedType(bytes) };
					this.cache.set({ ...key, variant: "full" }, entry);
					return { kind: "bytes", entry };
				}
				chunks.push(next.value);
				total += next.value.byteLength;
			}

			const head = concatBytes(chunks, total);
			return {
				kind: "stream",
				head,
				rest: iterator,
				mimeType: await sniffServedType(head),
				declaredSize,
			};
		} catch (error) {
			await iterator.return?.();
			throw error;
		}
	}

	private async fetchUpstream(
		did: string,
		cid: string,
		space: SpaceRefString | undefined,
	): Promise<Upstream> {
		const held = await this.fetchPolyfilled(did, cid);

		if (held) {
			return upstreamOfPolyfill(held);
		}

		if (space && (await this.polyfill?.hosts?.(did, space))) {
			throw new BlobNotFoundError();
		}

		const host = await this.hosts.hostFor(did);

		if (space) {
			return upstreamOf(await this.fetchFromSpace(space, host, did, cid));
		}

		return upstreamOf(await this.fetchPublic(host, did, cid));
	}

	private async fetchPolyfilled(did: string, cid: string): Promise<PolyfilledBlob | null> {
		if (!this.polyfill) {
			return null;
		}

		try {
			return await this.polyfill.open(did, cid);
		} catch (cause) {
			throw new BlobUpstreamError(`failed to read stored blob ${cid} for ${did}`, { cause });
		}
	}

	private async fetchFromSpace(
		space: SpaceRefString,
		host: string,
		did: string,
		cid: string,
	): Promise<Response> {
		try {
			return await this.spaceClient.getBlob(space, host, did, cid);
		} catch (cause) {
			if (cause instanceof XrpcError && cause.isNotFound) throw new BlobNotFoundError();
			throw new BlobUpstreamError(`failed to fetch blob ${cid} for ${did}`, { cause });
		}
	}

	private async fetchPublic(host: string, did: string, cid: string): Promise<Response> {
		const url = `${host.replace(/\/$/, "")}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url);
		} catch (cause) {
			throw new BlobUpstreamError(`failed to reach ${host}`, { cause });
		}
		if (response.status === 404 || (await reportsBlobNotFound(response))) {
			throw new BlobNotFoundError();
		}
		if (!response.ok) throw new BlobUpstreamError(`${host} responded ${response.status}`);
		return response;
	}
}

const toStreamResult = (original: StreamedOriginal, rangeHeader: string | null): BlobResult => {
	const stream = resumed(original.head, original.rest);
	const total = original.declaredSize;
	const parsed = rangeHeader && total !== null ? parseRange(rangeHeader, total) : null;

	if (parsed?.kind === "unsatisfiable" && total !== null) {
		void original.rest.return?.();
		return { status: "rangeNotSatisfiable", totalSize: total };
	}

	if (parsed?.kind === "partial") {
		return {
			status: "stream",
			stream: sliced(stream, parsed.start, parsed.end),
			mimeType: original.mimeType,
			totalSize: total,
			length: parsed.end - parsed.start + 1,
			range: { start: parsed.start, end: parsed.end },
		};
	}

	return {
		status: "stream",
		stream,
		mimeType: original.mimeType,
		totalSize: total,
		length: total,
	};
};

const reportsBlobNotFound = async (response: Response): Promise<boolean> => {
	if (response.status !== 400) return false;
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return body?.error === "BlobNotFound";
};

const toBlobResult = (
	entry: BlobCacheEntry,
	rangeHeader: string | null | undefined,
): BlobResult => {
	const outcome = applyRange(entry.bytes, rangeHeader ?? null);

	if (outcome.status === 416) {
		return { status: "rangeNotSatisfiable", totalSize: outcome.total };
	}

	if (outcome.status === 206) {
		return {
			status: "ok",
			bytes: outcome.bytes,
			mimeType: entry.mimeType,
			totalSize: outcome.total,
			range: { start: outcome.start, end: outcome.end },
		};
	}

	return {
		status: "ok",
		bytes: entry.bytes,
		mimeType: entry.mimeType,
		totalSize: entry.bytes.byteLength,
	};
};
