import type { SpaceClient, SpaceHostResolver, SpaceRefString } from "@colibri-social/space";
import { XrpcError } from "@colibri-social/space";
import type { BlobCacheEntry } from "./cache.js";
import { BlobCache } from "./cache.js";
import { BlobNotFoundError, BlobRejectedError, BlobUpstreamError } from "./errors.js";
import { sniffMimeType } from "./mime.js";
import { applyRange } from "./range.js";
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
			status: "rangeNotSatisfiable";
			totalSize: number;
	  };

export type BlobServiceOptions = {
	spaceClient: SpaceClient;
	hosts: SpaceHostResolver;
	cache?: BlobCache;
	fetch?: typeof globalThis.fetch;
	maxBlobBytes?: number;
};

const streamOf = (response: Response): AsyncIterable<Uint8Array> => {
	const body = response.body;
	if (!body) return (async function* () {})();
	return (async function* () {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				if (value) yield value;
			}
		} finally {
			reader.releaseLock();
		}
	})();
};

const concatBytes = (chunks: Uint8Array[], total: number): Uint8Array => {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

const collectVerifiedBytes = async (
	source: AsyncIterable<Uint8Array>,
	cid: string,
	maxBytes: number,
): Promise<Uint8Array> => {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of verifyingStream(source, cid)) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new BlobRejectedError("tooLarge");
		chunks.push(chunk);
	}
	return concatBytes(chunks, total);
};

export class BlobService {
	private readonly spaceClient: SpaceClient;
	private readonly hosts: SpaceHostResolver;
	private readonly cache: BlobCache;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly maxBlobBytes: number;

	constructor(options: BlobServiceOptions) {
		this.spaceClient = options.spaceClient;
		this.hosts = options.hosts;
		this.cache = options.cache ?? new BlobCache();
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
	}

	async fetch(params: BlobFetchParams): Promise<BlobResult> {
		const variant = params.variant ?? "full";
		const entry = await this.resolveEntry(params.did, params.cid, params.space, variant);
		return toBlobResult(entry, params.range);
	}

	private async resolveEntry(
		did: string,
		cid: string,
		space: SpaceRefString | undefined,
		variant: Variant,
	): Promise<BlobCacheEntry> {
		const cached = this.cache.get({ cid, variant });
		if (cached) return cached;

		const original = await this.resolveOriginal(did, cid, space);
		if (variant === "full") return original;

		const rendered = await renderVariant(original.bytes, original.mimeType, variant);
		const entry: BlobCacheEntry = { bytes: rendered.bytes, mimeType: rendered.mimeType };
		this.cache.set({ cid, variant }, entry);
		return entry;
	}

	private async resolveOriginal(
		did: string,
		cid: string,
		space: SpaceRefString | undefined,
	): Promise<BlobCacheEntry> {
		const cachedOriginal = this.cache.get({ cid, variant: "full" });
		if (cachedOriginal) return cachedOriginal;

		const response = await this.fetchUpstream(did, cid, space);
		const bytes = await collectVerifiedBytes(streamOf(response), cid, this.maxBlobBytes);
		const mimeType = await sniffMimeType(bytes);
		const entry: BlobCacheEntry = { bytes, mimeType };
		this.cache.set({ cid, variant: "full" }, entry);
		return entry;
	}

	private async fetchUpstream(
		did: string,
		cid: string,
		space: SpaceRefString | undefined,
	): Promise<Response> {
		const host = await this.hosts.hostFor(did);
		if (space) return this.fetchFromSpace(space, host, did, cid);
		return this.fetchPublic(host, did, cid);
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
		if (response.status === 404) throw new BlobNotFoundError();
		if (!response.ok) throw new BlobUpstreamError(`${host} responded ${response.status}`);
		return response;
	}
}

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
