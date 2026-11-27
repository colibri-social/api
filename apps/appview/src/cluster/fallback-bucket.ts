import type { BlobBucket, BlobBucketObject, BlobByteRange } from "@colibri-social/blobs";
import { ColibriError } from "../errors.js";
import type { Logger } from "../logger.js";

export const DIRECT_BLOB_TIMEOUT_MS = 5_000;

export const DIRECT_BLOB_COOLDOWN_MS = 30_000;

export type FallbackBucketDeps = {
	direct: BlobBucket;
	fallback: Pick<BlobBucket, "get">;
	log: Pick<Logger, "warn">;
	timeoutMs?: number;
	cooldownMs?: number;
	now?: () => number;
};

const timedOut = (): ColibriError => {
	return new ColibriError("BlobStoreTimeout", "The file store took too long to answer.", 503);
};

const discard = (object: BlobBucketObject | null): void => {
	const stream = object?.stream as { destroy?: () => void; return?: () => unknown } | undefined;

	if (stream?.destroy) {
		stream.destroy();

		return;
	}

	void Promise.resolve(stream?.return?.()).catch(() => undefined);
};

const withTimeout = (
	pending: Promise<BlobBucketObject | null>,
	timeoutMs: number,
): Promise<BlobBucketObject | null> => {
	let timer: NodeJS.Timeout | undefined;
	let expired = false;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			expired = true;
			reject(timedOut());
		}, timeoutMs);
	});

	void pending.then(
		(object) => {
			if (expired) discard(object);
		},
		() => undefined,
	);

	return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
};

export const fallbackBlobBucket = (deps: FallbackBucketDeps): BlobBucket => {
	const timeoutMs = deps.timeoutMs ?? DIRECT_BLOB_TIMEOUT_MS;
	const cooldownMs = deps.cooldownMs ?? DIRECT_BLOB_COOLDOWN_MS;
	const now = deps.now ?? Date.now;
	let skipDirectUntil = 0;

	const get = async (key: string, range?: BlobByteRange): Promise<BlobBucketObject | null> => {
		if (now() < skipDirectUntil) {
			return deps.fallback.get(key, range);
		}

		try {
			return await withTimeout(deps.direct.get(key, range), timeoutMs);
		} catch (error) {
			skipDirectUntil = now() + cooldownMs;
			deps.log.warn(
				{
					code: error instanceof ColibriError ? error.code : "BlobStoreUnreachable",
					err: error,
					key,
				},
				"cluster.blobDirectFailed",
			);

			return deps.fallback.get(key, range);
		}
	};

	return {
		put: (key, bytes, mimeType) => {
			return deps.direct.put(key, bytes, mimeType);
		},
		delete: (key) => {
			return deps.direct.delete(key);
		},
		get,
	};
};
