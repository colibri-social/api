import { createHmac, timingSafeEqual } from "node:crypto";

export const READ_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ReadTokenClaims = { did: string; channel: string; through: string; exp: number };

export type ReadTokenFailure = "InvalidToken" | "ExpiredToken";

export type ReadTokenResult =
	| { ok: true; claims: ReadTokenClaims }
	| { ok: false; reason: ReadTokenFailure };

const signature = (secret: string, encodedClaims: string): Buffer =>
	createHmac("sha256", secret).update(encodedClaims).digest();

export const signReadToken = (secret: string, claims: ReadTokenClaims): string => {
	const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${encodedClaims}.${signature(secret, encodedClaims).toString("base64url")}`;
};

export const issueReadToken = (
	secret: string,
	subject: { did: string; channel: string; through: string },
	nowMs: number,
): string =>
	signReadToken(secret, {
		did: subject.did,
		channel: subject.channel,
		through: subject.through,
		exp: Math.floor((nowMs + READ_TOKEN_TTL_MS) / 1000),
	});

const isClaims = (value: unknown): value is ReadTokenClaims => {
	if (!value || typeof value !== "object") return false;
	const claims = value as Record<string, unknown>;
	return (
		typeof claims.did === "string" &&
		claims.did.length > 0 &&
		typeof claims.channel === "string" &&
		claims.channel.length > 0 &&
		typeof claims.through === "string" &&
		claims.through.length > 0 &&
		typeof claims.exp === "number" &&
		Number.isFinite(claims.exp)
	);
};

const invalid: ReadTokenResult = { ok: false, reason: "InvalidToken" };

export const verifyReadToken = (secret: string, token: string, nowMs: number): ReadTokenResult => {
	const parts = token.split(".");
	if (parts.length !== 2) return invalid;
	const [encodedClaims, encodedSignature] = parts as [string, string];

	const expected = signature(secret, encodedClaims);
	const given = Buffer.from(encodedSignature, "base64url");
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;

	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
	} catch {
		return invalid;
	}
	if (!isClaims(claims)) return invalid;
	if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "ExpiredToken" };
	return {
		ok: true,
		claims: { did: claims.did, channel: claims.channel, through: claims.through, exp: claims.exp },
	};
};
