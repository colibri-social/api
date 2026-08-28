import type { Dispatcher } from "undici";
import { isEmbedError } from "./errors.js";
import { guardedFetch, type HostResolver } from "./fetch.js";
import type { MeasuredImage } from "./types.js";

export const PROXYABLE_IMAGE_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
] as const;

export type ProxyableImageType = (typeof PROXYABLE_IMAGE_TYPES)[number];

export function baseContentType(raw: string | undefined): string {
	return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function proxyableImageType(raw: string | undefined): ProxyableImageType | undefined {
	const base = baseContentType(raw);
	return PROXYABLE_IMAGE_TYPES.find((known) => known === base);
}

const MEASURE_TIMEOUT_MS = 5_000;

const MEASURE_MAX_BYTES = 192 * 1024;

export type ImageMeasurer = (url: string) => Promise<MeasuredImage | undefined>;

export type ImageDecoder = (bytes: Uint8Array) => Promise<MeasuredImage | null>;

export type ImageMeasurerOptions = {
	decode: ImageDecoder;
	onMiss?: (reason: string) => void;
	timeoutMs?: number;
	maxBytes?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
};

export function createImageMeasurer(options: ImageMeasurerOptions): ImageMeasurer {
	return async (url) => {
		const miss = (reason: string): undefined => {
			options.onMiss?.(reason);
			return undefined;
		};

		let result: Awaited<ReturnType<typeof guardedFetch>>;
		try {
			result = await guardedFetch(url, {
				headers: { accept: "image/*" },
				timeoutMs: options.timeoutMs ?? MEASURE_TIMEOUT_MS,
				maxResponseBytes: options.maxBytes ?? MEASURE_MAX_BYTES,
				dispatcher: options.dispatcher,
				resolveHost: options.resolveHost,
			});
		} catch (cause) {
			return miss(isEmbedError(cause) ? cause.reason : "the image could not be fetched");
		}

		if (result.statusCode < 200 || result.statusCode >= 300) {
			return miss(`the origin answered ${result.statusCode}`);
		}

		const mimeType = proxyableImageType(result.headers["content-type"]);
		if (!mimeType) {
			return miss(
				`the origin served ${baseContentType(result.headers["content-type"]) || "no content type"}`,
			);
		}

		const decoded = await options.decode(result.body);
		if (!decoded) return miss(`the ${mimeType} header could not be decoded`);

		return decoded;
	};
}
