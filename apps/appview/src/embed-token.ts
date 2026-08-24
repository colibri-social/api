import { createHmac, timingSafeEqual } from "node:crypto";
import { MEDIA_TOKEN_BUCKET_SECONDS, MEDIA_TOKEN_TTL_SECONDS } from "./media-token.js";

const VERSION = "v1";
const PURPOSE = "embed.get";

export type EmbedMediaKind = "image" | "video";

const payload = (kind: EmbedMediaKind, url: string, expiresAt: number): string =>
	[VERSION, PURPOSE, kind, url, String(expiresAt)].join("\n");

const digest = (signingKey: string, data: string): string =>
	createHmac("sha256", Buffer.from(signingKey, "hex")).update(data).digest("base64url");

export const embedTokenExpiry = (nowSeconds: number): number => {
	const bucketStart =
		Math.floor(nowSeconds / MEDIA_TOKEN_BUCKET_SECONDS) * MEDIA_TOKEN_BUCKET_SECONDS;
	const buckets = Math.ceil(MEDIA_TOKEN_TTL_SECONDS / MEDIA_TOKEN_BUCKET_SECONDS) + 1;
	return bucketStart + buckets * MEDIA_TOKEN_BUCKET_SECONDS;
};

export const embedMediaUrl = (
	options: { publicUrl: string; signingKey: string; nowSeconds: number },
	kind: EmbedMediaKind,
	target: string,
): string => {
	const expiresAt = embedTokenExpiry(options.nowSeconds);
	const method = kind === "image" ? "getImage" : "getVideo";
	const params = new URLSearchParams({
		url: target,
		exp: String(expiresAt),
		sig: digest(options.signingKey, payload(kind, target, expiresAt)),
	});
	return `${options.publicUrl}/xrpc/social.colibri.beta.embed.${method}?${params}`;
};

export const verifyEmbedToken = (
	signingKey: string,
	kind: EmbedMediaKind,
	url: string,
	expiresAt: number,
	signature: string,
	nowSeconds: number,
): boolean => {
	if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return false;
	const expected = Buffer.from(digest(signingKey, payload(kind, url, expiresAt)), "utf8");
	const supplied = Buffer.from(signature, "utf8");
	if (expected.byteLength !== supplied.byteLength) return false;
	return timingSafeEqual(expected, supplied);
};
