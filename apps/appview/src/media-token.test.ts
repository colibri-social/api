import { describe, expect, it } from "vitest";
import {
	MEDIA_TOKEN_BUCKET_SECONDS,
	MEDIA_TOKEN_TTL_SECONDS,
	mediaTokenExpiry,
	signBlobUrl,
	signMediaGrant,
	verifyMediaGrant,
} from "./media-token.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const NOW = 1_800_000_000;

const GRANT = {
	did: "did:plc:authorxxxxxxxxxxxxxxxxxxxxx",
	cid: "bafkreiblobxxxxxxxxxxxxxxxxxxxxxxxxxx",
	space: "at://did:plc:communityxxxxxxxxxxxxxxxxxxx/space/social.colibri.beta.channel.text/3lk1",
	viewer: "did:plc:viewerxxxxxxxxxxxxxxxxxxxxx",
};

const sign = (grant = GRANT, now = NOW, key = KEY) => signMediaGrant(key, grant, now);

describe("media grants", () => {
	it("round-trips a grant it just signed", () => {
		const { expiresAt, signature } = sign();
		expect(verifyMediaGrant(KEY, GRANT, expiresAt, signature, NOW)).toBe(true);
	});

	it("rejects a signature made with a different key", () => {
		const { expiresAt, signature } = sign(GRANT, NOW, OTHER_KEY);
		expect(verifyMediaGrant(KEY, GRANT, expiresAt, signature, NOW)).toBe(false);
	});

	it("refuses to let one field be swapped for another", () => {
		const { expiresAt, signature } = sign();
		for (const [field, value] of [
			["did", "did:plc:someoneelsexxxxxxxxxxxxxxxx"],
			["cid", "bafkreiotherblobxxxxxxxxxxxxxxxxxxxxx"],
			[
				"space",
				"at://did:plc:communityxxxxxxxxxxxxxxxxxxx/space/social.colibri.beta.channel.text/3lk2",
			],
			["viewer", "did:plc:intruderxxxxxxxxxxxxxxxxxxx"],
		] as const) {
			expect(verifyMediaGrant(KEY, { ...GRANT, [field]: value }, expiresAt, signature, NOW)).toBe(
				false,
			);
		}
	});

	it("rejects an expired grant, and one whose expiry was tampered with", () => {
		const { expiresAt, signature } = sign();
		expect(verifyMediaGrant(KEY, GRANT, expiresAt, signature, expiresAt + 1)).toBe(false);
		expect(verifyMediaGrant(KEY, GRANT, expiresAt + 3600, signature, NOW)).toBe(false);
	});

	it("rejects a malformed or empty signature without throwing", () => {
		const { expiresAt } = sign();
		for (const bad of ["", "not-a-signature", "!!!!"]) {
			expect(verifyMediaGrant(KEY, GRANT, expiresAt, bad, NOW)).toBe(false);
		}
		expect(verifyMediaGrant(KEY, GRANT, Number.NaN, "x", NOW)).toBe(false);
	});

	it("stays valid for at least the full lifetime", () => {
		const { expiresAt, signature } = sign();
		expect(expiresAt - NOW).toBeGreaterThanOrEqual(MEDIA_TOKEN_TTL_SECONDS);
		expect(verifyMediaGrant(KEY, GRANT, expiresAt, signature, NOW + MEDIA_TOKEN_TTL_SECONDS)).toBe(
			true,
		);
	});

	it("buckets the expiry so the same blob keeps one cacheable URL", () => {
		const first = mediaTokenExpiry(NOW);
		const later = mediaTokenExpiry(NOW + MEDIA_TOKEN_BUCKET_SECONDS - 1);
		expect(later).toBe(first);
		expect(sign(GRANT, NOW).signature).toBe(
			sign(GRANT, NOW + MEDIA_TOKEN_BUCKET_SECONDS - 1).signature,
		);

		const nextBucket = mediaTokenExpiry(NOW + MEDIA_TOKEN_BUCKET_SECONDS);
		expect(nextBucket).toBeGreaterThan(first);
	});

	it("puts the expiry on a bucket boundary", () => {
		expect(mediaTokenExpiry(NOW) % MEDIA_TOKEN_BUCKET_SECONDS).toBe(0);
		expect(mediaTokenExpiry(NOW + 37) % MEDIA_TOKEN_BUCKET_SECONDS).toBe(0);
	});
});

describe("signBlobUrl", () => {
	const unsigned = (space: string | null = GRANT.space) => {
		const url = new URL("/xrpc/social.colibri.beta.blob.get", "https://appview.test");
		url.searchParams.set("did", GRANT.did);
		url.searchParams.set("cid", GRANT.cid);
		if (space) url.searchParams.set("space", space);
		return url.toString();
	};

	it("appends a grant the blob route accepts for that viewer", () => {
		const signed = new URL(signBlobUrl(KEY, unsigned(), GRANT.viewer, NOW));
		expect(signed.searchParams.get("viewer")).toBe(GRANT.viewer);

		const expiresAt = Number(signed.searchParams.get("exp"));
		const signature = signed.searchParams.get("sig") as string;
		expect(verifyMediaGrant(KEY, GRANT, expiresAt, signature, NOW)).toBe(true);
		expect(
			verifyMediaGrant(
				KEY,
				{ ...GRANT, viewer: "did:plc:intruderxxxxxxxxxxxxxxxxxxx" },
				expiresAt,
				signature,
				NOW,
			),
		).toBe(false);
	});

	it("keeps the rest of the URL intact", () => {
		const signed = new URL(signBlobUrl(KEY, `${unsigned()}&filename=cat.png`, GRANT.viewer, NOW));
		expect(signed.pathname).toBe("/xrpc/social.colibri.beta.blob.get");
		expect(signed.searchParams.get("did")).toBe(GRANT.did);
		expect(signed.searchParams.get("cid")).toBe(GRANT.cid);
		expect(signed.searchParams.get("space")).toBe(GRANT.space);
		expect(signed.searchParams.get("filename")).toBe("cat.png");
	});

	it("leaves a public blob URL alone", () => {
		const url = unsigned(null);
		expect(signBlobUrl(KEY, url, GRANT.viewer, NOW)).toBe(url);
	});

	it("re-signs an already signed URL rather than stacking params", () => {
		const once = signBlobUrl(KEY, unsigned(), GRANT.viewer, NOW);
		const twice = new URL(signBlobUrl(KEY, once, "did:plc:secondxxxxxxxxxxxxxxxxxxxxx", NOW));
		expect(twice.searchParams.getAll("sig")).toHaveLength(1);
		expect(twice.searchParams.get("viewer")).toBe("did:plc:secondxxxxxxxxxxxxxxxxxxxxx");
	});
});
