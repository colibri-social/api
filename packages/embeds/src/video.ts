import type { Dispatcher } from "undici";
import { isEmbedError, upstreamFailure } from "./errors.js";
import { type GuardedFetchResult, guardedFetch, type HostResolver } from "./fetch.js";

export const PLAYABLE_VIDEO_TYPES = ["video/mp4", "video/webm"] as const;
export type PlayableVideoType = (typeof PLAYABLE_VIDEO_TYPES)[number];

export function playableVideoType(raw: string): PlayableVideoType | undefined {
	const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
	return PLAYABLE_VIDEO_TYPES.find((known) => known === base);
}

export function videoTypeFromExtension(url: URL): PlayableVideoType | undefined {
	const path = url.pathname.toLowerCase();
	if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
	if (path.endsWith(".webm")) return "video/webm";
	return undefined;
}

export type VideoProbe = {
	contentType: string;
	contentLength?: number;
	rangeSupported: boolean;
};

export type VideoProbeOptions = {
	timeoutMs?: number;
	dispatcher?: Dispatcher;
	resolveHost?: HostResolver;
};

function parseContentRangeTotal(headerValue: string | undefined): number | undefined {
	if (!headerValue) return undefined;
	const total = headerValue.split("/").at(-1)?.trim();
	if (!total) return undefined;
	const parsed = Number.parseInt(total, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseContentLength(headerValue: string | undefined): number | undefined {
	if (!headerValue) return undefined;
	const parsed = Number.parseInt(headerValue, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export async function probeVideo(
	rawUrl: string,
	options: VideoProbeOptions = {},
): Promise<VideoProbe> {
	let result: GuardedFetchResult;
	try {
		result = await guardedFetch(rawUrl, {
			headers: { range: "bytes=0-0" },
			maxResponseBytes: 0,
			timeoutMs: options.timeoutMs,
			dispatcher: options.dispatcher,
			resolveHost: options.resolveHost,
		});
	} catch (cause) {
		if (isEmbedError(cause)) throw cause;
		throw upstreamFailure(`probing '${rawUrl}' failed`, cause);
	}

	if (result.statusCode < 200 || result.statusCode >= 300) {
		throw upstreamFailure(`upstream returned status ${result.statusCode}`);
	}

	const contentType = result.headers["content-type"] ?? "application/octet-stream";
	const rangeSupported = result.statusCode === 206 || result.headers["content-range"] !== undefined;
	const contentLength =
		parseContentRangeTotal(result.headers["content-range"]) ??
		parseContentLength(result.headers["content-length"]);

	return {
		contentType,
		rangeSupported,
		...(contentLength !== undefined ? { contentLength } : {}),
	};
}
