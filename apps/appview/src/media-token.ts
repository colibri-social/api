import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const PURPOSE = "blob.get";

export const MEDIA_TOKEN_TTL_SECONDS = 3600;
export const MEDIA_TOKEN_BUCKET_SECONDS = 900;

export type MediaGrant = {
	did: string;
	cid: string;
	space: string;
	viewer: string;
};

const payload = (grant: MediaGrant, expiresAt: number): string =>
	[VERSION, PURPOSE, grant.did, grant.cid, grant.space, grant.viewer, String(expiresAt)].join("\n");

const digest = (signingKey: string, data: string): string =>
	createHmac("sha256", Buffer.from(signingKey, "hex")).update(data).digest("base64url");

export const mediaTokenExpiry = (nowSeconds: number): number => {
	const bucketStart =
		Math.floor(nowSeconds / MEDIA_TOKEN_BUCKET_SECONDS) * MEDIA_TOKEN_BUCKET_SECONDS;
	const buckets = Math.ceil(MEDIA_TOKEN_TTL_SECONDS / MEDIA_TOKEN_BUCKET_SECONDS) + 1;
	return bucketStart + buckets * MEDIA_TOKEN_BUCKET_SECONDS;
};

export const signMediaGrant = (
	signingKey: string,
	grant: MediaGrant,
	nowSeconds: number,
): { expiresAt: number; signature: string } => {
	const expiresAt = mediaTokenExpiry(nowSeconds);
	return { expiresAt, signature: digest(signingKey, payload(grant, expiresAt)) };
};

export const verifyMediaGrant = (
	signingKey: string,
	grant: MediaGrant,
	expiresAt: number,
	signature: string,
	nowSeconds: number,
): boolean => {
	if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return false;
	const expected = Buffer.from(digest(signingKey, payload(grant, expiresAt)), "utf8");
	const supplied = Buffer.from(signature, "utf8");
	if (expected.byteLength !== supplied.byteLength) return false;
	return timingSafeEqual(expected, supplied);
};

export const signBlobUrl = (
	signingKey: string,
	url: string,
	viewer: string,
	nowSeconds: number,
): string => {
	const parsed = new URL(url);
	const did = parsed.searchParams.get("did");
	const cid = parsed.searchParams.get("cid");
	const space = parsed.searchParams.get("space");
	if (!did || !cid || !space) return url;

	const { expiresAt, signature } = signMediaGrant(
		signingKey,
		{ did, cid, space, viewer },
		nowSeconds,
	);
	parsed.searchParams.set("viewer", viewer);
	parsed.searchParams.set("exp", String(expiresAt));
	parsed.searchParams.set("sig", signature);
	return parsed.toString();
};
