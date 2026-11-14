import { Readable } from "node:stream";
import type { Server } from "@atproto/xrpc-server";
import type { Database } from "@colibri-social/appview-db";
import {
	type BlobBucket,
	type BlobBucketConfig,
	blobBucketKey,
	cidForRawBytes,
	DOWNLOAD_MIME_TYPE,
	type PolyfillBlobSource,
	S3BlobBucket,
	sniffMimeType,
	verifyingStream,
} from "@colibri-social/blobs";
import { blobCid, social, toLexForm } from "@colibri-social/lexicons";
import { tryParseSpaceRef } from "@colibri-social/space";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { AuthVerifiers } from "../auth.js";
import { ColibriError, notFound, toXrpcError } from "../errors.js";
import type { Logger } from "../logger.js";
import { route } from "../route.js";
import { isAuthoritativeHere, repoHostMode } from "./host-mode.js";

export const POLYFILL_BLOB_MAX_BYTES = 75 * 1024 * 1024;
export const POLYFILL_BLOB_UNREFERENCED_MS = 24 * 60 * 60_000;

const SWEEP_INTERVAL_MS = 60 * 60_000;
const SWEEP_BATCH_SIZE = 100;
const MAX_RECORD_DEPTH = 32;

export type PolyfillBlobRow = {
	cid: string;
	author: string;
	mime: string;
	size: number;
	s3Key: string;
	createdAt: string;
	referencedAt: string | null;
};

export type PolyfillBlobIndex = {
	find: (author: string, cid: string) => Promise<PolyfillBlobRow | null>;
	record: (row: Omit<PolyfillBlobRow, "referencedAt">) => Promise<void>;
	markReferenced: (author: string, cids: readonly string[], at: string) => Promise<void>;
	stale: (before: string, limit: number) => Promise<PolyfillBlobRow[]>;
	forget: (row: PolyfillBlobRow, before: string) => Promise<void>;
};

export type IsHosted = (did: string) => Promise<boolean>;

export type PolyfillBlobDeps = {
	index: PolyfillBlobIndex;
	bucket: BlobBucket | null;
	isHosted: IsHosted;
	now?: () => Date;
};

export type PolyfillBlobOutput = {
	encoding: string;
	body: Readable;
	headers: Record<string, string>;
};

export const polyfillBlobIndex = (database: Pick<Database, "primary" | "tables">) => {
	const { primary, tables } = database;
	const table = tables.polyfillBlobs;

	const index: PolyfillBlobIndex = {
		find: async (author, cid) => {
			const [row] = await primary
				.select()
				.from(table)
				.where(and(eq(table.author, author), eq(table.cid, cid)))
				.limit(1);

			return row ?? null;
		},
		record: async (row) => {
			await primary
				.insert(table)
				.values({ ...row, referencedAt: null })
				.onConflictDoUpdate({
					target: [table.author, table.cid],
					set: { createdAt: row.createdAt, s3Key: row.s3Key },
				});
		},
		markReferenced: async (author, cids, at) => {
			if (cids.length === 0) {
				return;
			}

			await primary
				.update(table)
				.set({ referencedAt: at })
				.where(
					and(eq(table.author, author), inArray(table.cid, [...cids]), isNull(table.referencedAt)),
				);
		},
		stale: async (before, limit) => {
			return primary
				.select()
				.from(table)
				.where(and(isNull(table.referencedAt), lt(table.createdAt, before)))
				.limit(limit);
		},
		forget: async (row, before) => {
			await primary
				.delete(table)
				.where(
					and(
						eq(table.author, row.author),
						eq(table.cid, row.cid),
						isNull(table.referencedAt),
						lt(table.createdAt, before),
					),
				);
		},
	};

	return index;
};

export const polyfillBucket = (config: BlobBucketConfig | null): BlobBucket | null => {
	return config ? new S3BlobBucket(config) : null;
};

const storageUnavailable = () => {
	return new ColibriError(
		"BlobStorageUnavailable",
		"This server can't store files right now. Try again later.",
		503,
	);
};

const tooLarge = () => {
	return new ColibriError(
		"BlobTooLarge",
		`Files can be up to ${POLYFILL_BLOB_MAX_BYTES / 1024 / 1024} MB.`,
		413,
	);
};

const readCapped = async (source: AsyncIterable<Uint8Array> | Uint8Array): Promise<Uint8Array> => {
	if (source instanceof Uint8Array) {
		if (source.byteLength > POLYFILL_BLOB_MAX_BYTES) {
			throw tooLarge();
		}

		return source;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;

	for await (const chunk of source) {
		total += chunk.byteLength;

		if (total > POLYFILL_BLOB_MAX_BYTES) {
			throw tooLarge();
		}

		chunks.push(chunk);
	}

	const out = new Uint8Array(total);
	let offset = 0;

	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return out;
};

export const handleUploadPolyfillBlob = async (
	deps: PolyfillBlobDeps,
	actor: string,
	body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<{ blob: social.colibri.beta.polyfill.uploadBlob.$OutputBody["blob"] }> => {
	if (!(await deps.isHosted(actor))) {
		throw new ColibriError(
			"RepoNotHosted",
			"Colibri doesn't store files for this account. Upload to your own server instead.",
		);
	}

	if (!deps.bucket) {
		throw storageUnavailable();
	}

	const bytes = await readCapped(body);

	if (bytes.byteLength === 0) {
		throw new ColibriError("InvalidRequest", "The file is empty.");
	}

	const mime = await sniffMimeType(bytes).catch(() => DOWNLOAD_MIME_TYPE);
	const cid = (await cidForRawBytes(bytes)).toString();
	const s3Key = blobBucketKey(actor, cid);
	const createdAt = (deps.now?.() ?? new Date()).toISOString();

	await deps.bucket.put(s3Key, bytes, mime);
	await deps.index.record({ cid, author: actor, mime, size: bytes.byteLength, s3Key, createdAt });

	return {
		blob: toLexForm({
			$type: "blob",
			ref: { $link: cid },
			mimeType: mime,
			size: bytes.byteLength,
		}) as never,
	};
};

const blobNotFound = () => {
	return notFound("BlobNotFound", "There's no stored file with that ID for this account.");
};

export const handleGetPolyfillBlob = async (
	deps: PolyfillBlobDeps,
	actor: string,
	cid: string,
): Promise<PolyfillBlobOutput> => {
	const row = await deps.index.find(actor, cid);

	if (!row) {
		throw blobNotFound();
	}

	if (!deps.bucket) {
		throw storageUnavailable();
	}

	const object = await deps.bucket.get(row.s3Key);

	if (!object) {
		throw blobNotFound();
	}

	return {
		encoding: row.mime,
		body: Readable.from(verifyingStream(object.stream, cid), { objectMode: false }),
		headers: { "content-length": String(row.size) },
	};
};

export const polyfillBlobSource = (
	index: PolyfillBlobIndex,
	bucket: BlobBucket | null,
	database: Pick<Database, "primary" | "tables">,
): PolyfillBlobSource => {
	const tables = { db: database.primary, tables: database.tables };

	return {
		hosts: async (did, space) => {
			const uri = tryParseSpaceRef(space)?.uri;

			return uri !== undefined && isAuthoritativeHere(await repoHostMode(tables, uri, did));
		},
		open: async (did, cid) => {
			if (!bucket) {
				return null;
			}

			const row = await index.find(did, cid);

			if (!row) {
				return null;
			}

			const object = await bucket.get(row.s3Key);

			return object ? { stream: object.stream, size: row.size } : null;
		},
	};
};

const collectBlobCids = (value: unknown, found: Set<string>, depth: number): void => {
	if (depth > MAX_RECORD_DEPTH || value === null || typeof value !== "object") {
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectBlobCids(item, found, depth + 1);
		}

		return;
	}

	if ((value as { $type?: unknown }).$type === "blob") {
		const cid = blobCid(value);

		if (cid) {
			found.add(cid);
		}

		return;
	}

	for (const item of Object.values(value)) {
		collectBlobCids(item, found, depth + 1);
	}
};

export const referencedBlobCids = (record: unknown): string[] => {
	const found = new Set<string>();

	collectBlobCids(record, found, 0);

	return [...found];
};

export const markReferenced = async (
	index: PolyfillBlobIndex,
	author: string,
	cids: readonly string[],
	now: Date = new Date(),
): Promise<void> => {
	await index.markReferenced(author, [...new Set(cids)], now.toISOString());
};

export type PolyfillBlobSweepOptions = {
	index: PolyfillBlobIndex;
	bucket: BlobBucket | null;
	now?: Date;
	maxAgeMs?: number;
	batchSize?: number;
};

export const sweepPolyfillBlobs = async (options: PolyfillBlobSweepOptions): Promise<number> => {
	const { index, bucket } = options;

	if (!bucket) {
		return 0;
	}

	const now = options.now ?? new Date();
	const before = new Date(
		now.getTime() - (options.maxAgeMs ?? POLYFILL_BLOB_UNREFERENCED_MS),
	).toISOString();
	const batchSize = options.batchSize ?? SWEEP_BATCH_SIZE;
	let swept = 0;

	while (true) {
		const rows = await index.stale(before, batchSize);

		for (const row of rows) {
			await bucket.delete(row.s3Key);
			await index.forget(row, before);
		}

		swept += rows.length;

		if (rows.length < batchSize) {
			return swept;
		}
	}
};

export class PolyfillBlobSweeper {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly deps: { index: PolyfillBlobIndex; bucket: BlobBucket | null; log: Logger },
		private readonly intervalMs = SWEEP_INTERVAL_MS,
	) {}

	start(): void {
		if (this.timer || !this.deps.bucket) {
			return;
		}

		const { index, bucket, log } = this.deps;

		const run = () => {
			void sweepPolyfillBlobs({ index, bucket })
				.then((swept) => {
					if (swept > 0) log.info({ swept }, "polyfill.blobs.swept");
				})
				.catch((error: unknown) =>
					log.warn({ code: "BlobSweepFailed", err: error }, "polyfill.blobs.sweepFailed"),
				);
		};

		run();
		this.timer = setInterval(run, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) {
			return;
		}

		clearInterval(this.timer);
		this.timer = null;
	}
}

export const mountPolyfillBlobRoutes = (
	server: Server,
	auth: AuthVerifiers,
	deps: PolyfillBlobDeps,
): void => {
	route(server, social.colibri.beta.polyfill.uploadBlob, {
		auth: auth.required,
		opts: { blobLimit: POLYFILL_BLOB_MAX_BYTES },
		handler: async ({ input, auth: caller }) => {
			try {
				return {
					encoding: "application/json" as const,
					body: await handleUploadPolyfillBlob(
						deps,
						caller.credentials.did,
						input.body as AsyncIterable<Uint8Array> | Uint8Array,
					),
				};
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});

	route(server, social.colibri.beta.polyfill.getBlob, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			try {
				return (await handleGetPolyfillBlob(deps, caller.credentials.did, params.cid)) as never;
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});
};
