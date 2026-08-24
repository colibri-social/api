import { describe, expect, it } from "vitest";
import { embedMediaUrl, embedTokenExpiry, verifyEmbedToken } from "./embed-token.js";

const SIGNING_KEY = "a".repeat(64);
const NOW = 1_787_000_000;
const TARGET = "https://example.test/cover.png";

const signed = (kind: "image" | "video", target = TARGET, now = NOW) =>
	new URL(
		embedMediaUrl(
			{ publicUrl: "https://appview.test", signingKey: SIGNING_KEY, nowSeconds: now },
			kind,
			target,
		),
	);

describe("embed media links", () => {
	it("names the method for the kind and carries the target", () => {
		expect(signed("image").pathname).toBe("/xrpc/social.colibri.beta.embed.getImage");
		expect(signed("video").pathname).toBe("/xrpc/social.colibri.beta.embed.getVideo");
		expect(signed("image").searchParams.get("url")).toBe(TARGET);
	});

	it("accepts its own signature and rejects a tampered target", () => {
		const url = signed("image");
		const expiry = Number(url.searchParams.get("exp"));
		const signature = url.searchParams.get("sig") as string;

		expect(verifyEmbedToken(SIGNING_KEY, "image", TARGET, expiry, signature, NOW)).toBe(true);
		expect(
			verifyEmbedToken(SIGNING_KEY, "image", "https://evil.test/x.png", expiry, signature, NOW),
		).toBe(false);
	});

	it("does not let an image link fetch a video, or the other way round", () => {
		const url = signed("image");
		const expiry = Number(url.searchParams.get("exp"));
		const signature = url.searchParams.get("sig") as string;

		expect(verifyEmbedToken(SIGNING_KEY, "video", TARGET, expiry, signature, NOW)).toBe(false);
	});

	it("refuses a link past its expiry", () => {
		const url = signed("image");
		const expiry = Number(url.searchParams.get("exp"));
		const signature = url.searchParams.get("sig") as string;

		expect(verifyEmbedToken(SIGNING_KEY, "image", TARGET, expiry, signature, expiry + 1)).toBe(
			false,
		);
	});

	it("buckets the expiry so the same target keeps one cacheable link", () => {
		expect(embedTokenExpiry(NOW)).toBe(embedTokenExpiry(NOW + 60));
		expect(signed("image", TARGET, NOW).href).toBe(signed("image", TARGET, NOW + 60).href);
	});
});
