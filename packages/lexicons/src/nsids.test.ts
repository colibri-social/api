import { describe, expect, it } from "vitest";
import { canonicalSpaceUri, canonicalSpaceUris, spaceTypeOf, spaceUri } from "./nsids.js";

const DID = "did:plc:abc123";
const TEXT = `at:space/${DID}/social.colibri.beta.channel.text/general`;
const LEGACY_TEXT = `at://${DID}/space/social.colibri.beta.channel.text/general`;
const EMOJI = `at://${DID}/blue.moji.collection.item/party`;

describe("space URIs", () => {
	it("builds the at:space/ form", () => {
		expect(spaceUri(DID, "social.colibri.beta.channel.text", "general")).toBe(TEXT);
	});

	it("rewrites the legacy form and leaves public URIs alone", () => {
		expect(canonicalSpaceUri(LEGACY_TEXT)).toBe(TEXT);
		expect(canonicalSpaceUri(TEXT)).toBe(TEXT);
		expect(canonicalSpaceUri(EMOJI)).toBe(EMOJI);
	});

	it("reads the space type from either form", () => {
		expect(spaceTypeOf(TEXT)).toBe("social.colibri.beta.channel.text");
		expect(spaceTypeOf(LEGACY_TEXT)).toBe("social.colibri.beta.channel.text");
		expect(spaceTypeOf(EMOJI)).toBeUndefined();
	});

	it("rewrites nested values and keeps other objects as they are", () => {
		const bytes = new Uint8Array([1, 2, 3]);

		expect(canonicalSpaceUris({ uri: LEGACY_TEXT, list: [LEGACY_TEXT, EMOJI], bytes })).toEqual({
			uri: TEXT,
			list: [TEXT, EMOJI],
			bytes,
		});
	});
});
