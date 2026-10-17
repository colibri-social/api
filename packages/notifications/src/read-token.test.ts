import { describe, expect, it } from "vitest";
import { issueReadToken, READ_TOKEN_TTL_MS, signReadToken, verifyReadToken } from "./read-token.js";

const SECRET = "k".repeat(32);
const NOW_MS = Date.parse("2026-10-17T00:00:00.000Z");
const CHANNEL = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1";
const OTHER_CHANNEL = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel2";
const subject = { did: "did:plc:reader", channel: CHANNEL, through: "3lkmsg1" };

const reencode = (token: string, change: (claims: Record<string, unknown>) => void): string => {
	const [claims, signature] = token.split(".");
	const parsed = JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8"));
	change(parsed);
	return `${Buffer.from(JSON.stringify(parsed)).toString("base64url")}.${signature}`;
};

describe("read tokens", () => {
	it("round trips the claims and expires after seven days", () => {
		const token = issueReadToken(SECRET, subject, NOW_MS);

		expect(verifyReadToken(SECRET, token, NOW_MS)).toEqual({
			ok: true,
			claims: { ...subject, exp: Math.floor((NOW_MS + READ_TOKEN_TTL_MS) / 1000) },
		});
		expect(verifyReadToken(SECRET, token, NOW_MS + READ_TOKEN_TTL_MS - 1000).ok).toBe(true);
	});

	it("rejects an expired token as expired", () => {
		const token = issueReadToken(SECRET, subject, NOW_MS);

		expect(verifyReadToken(SECRET, token, NOW_MS + READ_TOKEN_TTL_MS)).toEqual({
			ok: false,
			reason: "ExpiredToken",
		});
	});

	it("rejects a token whose claims were changed to another channel", () => {
		const token = reencode(issueReadToken(SECRET, subject, NOW_MS), (claims) => {
			claims.channel = OTHER_CHANNEL;
		});

		expect(verifyReadToken(SECRET, token, NOW_MS)).toEqual({ ok: false, reason: "InvalidToken" });
	});

	it("rejects a token with a pushed out expiry", () => {
		const token = reencode(issueReadToken(SECRET, subject, NOW_MS), (claims) => {
			claims.exp = Number(claims.exp) + 1000;
		});

		expect(verifyReadToken(SECRET, token, NOW_MS)).toEqual({ ok: false, reason: "InvalidToken" });
	});

	it("rejects a token signed with another secret", () => {
		const token = issueReadToken("x".repeat(32), subject, NOW_MS);

		expect(verifyReadToken(SECRET, token, NOW_MS)).toEqual({ ok: false, reason: "InvalidToken" });
	});

	it("rejects malformed tokens and claims", () => {
		for (const token of ["", "abc", "a.b.c", "....", `${"a".repeat(10)}.`]) {
			expect(verifyReadToken(SECRET, token, NOW_MS)).toEqual({ ok: false, reason: "InvalidToken" });
		}
		const incomplete = signReadToken(SECRET, { ...subject, through: "", exp: 9_999_999_999 });
		expect(verifyReadToken(SECRET, incomplete, NOW_MS)).toEqual({
			ok: false,
			reason: "InvalidToken",
		});
	});
});
