import { describe, expect, it } from "vitest";
import { SpaceRefError } from "./errors.js";
import {
	parseSpaceRecordUri,
	parseSpaceRef,
	recordPath,
	spaceRecordUri,
	spaceRef,
	tryParseSpaceRef,
} from "./space-ref.js";

const COMMUNITY = "did:plc:2hnjxkqm6bpuvvpjbztkxxxx";
const AUTHOR = "did:plc:7fkdlwjqmzcuvvpjbztkyyyy";
const CHANNEL = "social.colibri.beta.channel.text";
const SKEY = "3lkabcdefgh2k";

describe("space references", () => {
	it("builds a space reference from its three parts", () => {
		expect(spaceRef(COMMUNITY, CHANNEL, SKEY)).toBe(`at://${COMMUNITY}/space/${CHANNEL}/${SKEY}`);
	});

	it("round trips a space reference", () => {
		const parsed = parseSpaceRef(spaceRef(COMMUNITY, CHANNEL, SKEY));
		expect(parsed).toEqual({
			authority: COMMUNITY,
			spaceType: CHANNEL,
			skey: SKEY,
			uri: `at://${COMMUNITY}/space/${CHANNEL}/${SKEY}`,
		});
	});

	it("refuses a public record uri", () => {
		expect(() => parseSpaceRef(`at://${COMMUNITY}/social.colibri.beta.community/self`)).toThrow(
			SpaceRefError,
		);
	});

	it("reports an unparseable reference as null rather than throwing", () => {
		expect(tryParseSpaceRef("not a uri")).toBeNull();
	});

	it("refuses an authority that is not a DID", () => {
		expect(() => spaceRef("example.com", CHANNEL, SKEY)).toThrow();
	});

	it("refuses a space type that is not an NSID", () => {
		expect(() => spaceRef(COMMUNITY, "channel", SKEY)).toThrow();
	});
});

describe("space record references", () => {
	const space = spaceRef(COMMUNITY, CHANNEL, SKEY);

	it("addresses a record by space, author, collection and key", () => {
		expect(spaceRecordUri(space, AUTHOR, "social.colibri.beta.message", "3lxyz")).toBe(
			`at://${COMMUNITY}/space/${CHANNEL}/${SKEY}/${AUTHOR}/social.colibri.beta.message/3lxyz`,
		);
	});

	it("round trips a record reference", () => {
		const uri = spaceRecordUri(space, AUTHOR, "social.colibri.beta.message", "3lxyz");
		expect(parseSpaceRecordUri(uri)).toEqual({
			authority: COMMUNITY,
			spaceType: CHANNEL,
			skey: SKEY,
			uri: space,
			author: AUTHOR,
			collection: "social.colibri.beta.message",
			rkey: "3lxyz",
		});
	});

	it("distinguishes the author from the space authority", () => {
		const uri = spaceRecordUri(space, AUTHOR, "social.colibri.beta.message", "3lxyz");
		const parsed = parseSpaceRecordUri(uri);
		expect(parsed.author).not.toBe(parsed.authority);
	});

	it("refuses a space reference with no record on it", () => {
		expect(() => parseSpaceRecordUri(space)).toThrow(SpaceRefError);
	});

	it("formats the path the repo index and set hash both use", () => {
		expect(recordPath("social.colibri.beta.message", "3lxyz")).toBe(
			"social.colibri.beta.message/3lxyz",
		);
	});
});
