import { describe, expect, it } from "vitest";
import {
	allowsCustomEmoji,
	CUSTOM_EMOJI_FEATURE,
	customEmojiPolicy,
	filterCustomEmojiFacets,
} from "./emoji-policy.js";

const COMMUNITY = "did:plc:community";
const local = `at://${COMMUNITY}/blue.moji.collection.item/shipit`;
const foreign = "at://did:plc:other/blue.moji.collection.item/owl";
const mention = { $type: "social.colibri.beta.richtext.facet#mention", did: "did:plc:x" };

const facet = (byteStart: number, ...features: unknown[]) => ({
	index: { byteStart, byteEnd: byteStart + 4 },
	features,
});

describe("custom emoji policy", () => {
	it("reads unknown and missing values as all", () => {
		expect(customEmojiPolicy(undefined)).toBe("all");
		expect(customEmojiPolicy("something")).toBe("all");
		expect(customEmojiPolicy("local")).toBe("local");
		expect(customEmojiPolicy("none")).toBe("none");
	});

	it("allows emoji by the repo that owns the record", () => {
		expect(allowsCustomEmoji("all", COMMUNITY, foreign)).toBe(true);
		expect(allowsCustomEmoji("local", COMMUNITY, local)).toBe(true);
		expect(allowsCustomEmoji("local", COMMUNITY, foreign)).toBe(false);
		expect(allowsCustomEmoji("none", COMMUNITY, local)).toBe(false);
	});

	it("strips disallowed emoji and keeps the text's other facets", () => {
		const facets = [
			facet(0, { $type: CUSTOM_EMOJI_FEATURE, uri: local }),
			facet(5, { $type: CUSTOM_EMOJI_FEATURE, uri: foreign }),
			facet(10, mention, { $type: CUSTOM_EMOJI_FEATURE, uri: foreign }),
		];
		expect(filterCustomEmojiFacets(facets, "all", COMMUNITY)).toEqual(facets);
		const localOnly = filterCustomEmojiFacets(facets, "local", COMMUNITY);
		expect(localOnly).toEqual([facets[0], { ...facets[2], features: [mention] }]);
		expect(filterCustomEmojiFacets(facets, "none", COMMUNITY)).toEqual([
			{ ...facets[2], features: [mention] },
		]);
		expect(filterCustomEmojiFacets([facets[1] as never], "none", COMMUNITY)).toBeUndefined();
	});
});
