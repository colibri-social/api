import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { BlobBucket, BlobBucketObject, BlobByteRange } from "@colibri-social/blobs";
import { ColibriError } from "../errors.js";
import { type NodeCredentials, readNodeCredentials } from "./node-secret.js";
import { BLOB_PATH, NODE_ID_HEADER, NODE_SECRET_HEADER } from "./protocol.js";

export const REMOTE_BLOB_TIMEOUT_MS = 15_000;

export type RemoteBucketDeps = {
	mainUrl: string | (() => Promise<string | null>);
	secretFile: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

const unavailable = (): ColibriError => {
	return new ColibriError(
		"BlobStorageUnavailable",
		"This server can't reach stored files right now. Try again later.",
		503,
	);
};

export const rangeHeader = (range: BlobByteRange): string => {
	return `bytes=${range.start}-${range.end}`;
};

export const parseRangeHeader = (value: string | undefined): BlobByteRange | null => {
	const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? "");

	if (!match) {
		return null;
	}

	const start = Number(match[1]);
	const end = Number(match[2]);

	return end >= start ? { start, end } : null;
};

export const remoteBlobBucket = (deps: RemoteBucketDeps): BlobBucket => {
	const fetchImpl = deps.fetch ?? fetch;
	let credentials: NodeCredentials | null = null;

	const mainUrlOf = async (): Promise<string> => {
		const mainUrl = typeof deps.mainUrl === "string" ? deps.mainUrl : await deps.mainUrl();

		if (!mainUrl) {
			throw unavailable();
		}

		return mainUrl;
	};

	const credentialsOf = async (): Promise<NodeCredentials> => {
		credentials ??= await readNodeCredentials(deps.secretFile);

		if (!credentials) {
			throw unavailable();
		}

		return credentials;
	};

	return {
		put: async () => {
			throw unavailable();
		},
		delete: async () => {
			throw unavailable();
		},
		get: async (key, range): Promise<BlobBucketObject | null> => {
			const { id, secret } = await credentialsOf();
			const url = new URL(BLOB_PATH, await mainUrlOf());
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? REMOTE_BLOB_TIMEOUT_MS);

			url.searchParams.set("key", key);

			const response = await fetchImpl(url, {
				headers: {
					[NODE_ID_HEADER]: id,
					[NODE_SECRET_HEADER]: secret,
					...(range ? { range: rangeHeader(range) } : {}),
				},
				signal: abort.signal,
			})
				.catch((cause: unknown) => {
					throw Object.assign(unavailable(), { cause });
				})
				.finally(() => clearTimeout(timer));

			if (response.status === 404) {
				await response.body?.cancel();

				return null;
			}

			if (!response.ok || !response.body) {
				await response.body?.cancel();

				throw unavailable();
			}

			const length = Number(response.headers.get("content-length"));

			return {
				stream: Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
				length: Number.isFinite(length) && length > 0 ? length : null,
			};
		},
	};
};
