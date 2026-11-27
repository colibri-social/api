import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { routeOf, spaceAuthority } from "./route-table.js";

const LEXICONS = fileURLToPath(
	new URL("../../../../packages/lexicons/lexicons/social/colibri/beta", import.meta.url),
);

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(join(dir, entry.name))
			: entry.name.endsWith(".json")
				? [join(dir, entry.name)]
				: [],
	);

const methods = walk(LEXICONS).flatMap((path) => {
	const doc = JSON.parse(readFileSync(path, "utf8")) as {
		id: string;
		defs: { main?: { type?: string } };
	};
	const type = doc.defs.main?.type;

	return type === "query" || type === "procedure" || type === "subscription" ? [doc.id] : [];
});

const SPACE = "did:plc:spacexxxxxxxxxxxxxxxxxxxxx";
const CHANNEL = `at:space/${SPACE}/social.colibri.beta.channel.text/general`;
const LEGACY_CHANNEL = `at://${SPACE}/space/social.colibri.beta.channel.text/general`;

describe("routeOf", () => {
	it("classifies every Colibri method as local or routed by a Space", () => {
		expect(methods.length).toBeGreaterThan(100);
		expect(methods.filter((nsid) => routeOf(nsid) === undefined)).toEqual([]);
	});
});

describe("spaceAuthority", () => {
	it("reads a community DID from the query or the body", () => {
		const route = routeOf("social.colibri.beta.community.getCommunity");

		expect(spaceAuthority(route, new URLSearchParams({ community: SPACE }), undefined)).toBe(SPACE);
		expect(spaceAuthority(route, new URLSearchParams(), { community: SPACE })).toBe(SPACE);
	});

	it("takes the authority of a space reference in either form", () => {
		const route = routeOf("social.colibri.beta.channel.listMessages");

		expect(spaceAuthority(route, new URLSearchParams({ channel: CHANNEL }), undefined)).toBe(SPACE);
		expect(spaceAuthority(route, new URLSearchParams({ channel: LEGACY_CHANNEL }), undefined)).toBe(
			SPACE,
		);
	});

	it("routes nothing for local methods, missing keys or malformed values", () => {
		expect(
			spaceAuthority(
				routeOf("social.colibri.beta.actor.listCommunities"),
				new URLSearchParams({ community: SPACE }),
				undefined,
			),
		).toBeUndefined();
		expect(
			spaceAuthority(
				routeOf("social.colibri.beta.channel.listMessages"),
				new URLSearchParams({ channel: "not a space" }),
				undefined,
			),
		).toBeUndefined();
		expect(
			spaceAuthority(
				routeOf("social.colibri.beta.community.getCommunity"),
				new URLSearchParams({ community: "alice.example" }),
				undefined,
			),
		).toBeUndefined();
	});

	it("sends a preferences grant to the AppView of the named community, and keeps it local without one", () => {
		const route = routeOf("social.colibri.beta.actor.grantSpaceAccess");
		const grant = {
			space: "at:space/did:plc:userxxxxxxxxxxxxxxxxxxxxxx/prefs",
			delegationToken: "t",
		};

		expect(spaceAuthority(route, new URLSearchParams(), { ...grant, community: SPACE })).toBe(
			SPACE,
		);
		expect(spaceAuthority(route, new URLSearchParams(), grant)).toBeUndefined();
	});

	it("sends a polyfill blob to the AppView of the space it names, and keeps it local without one", () => {
		const channel = `at:space/${SPACE}/social.colibri.beta.channel.text/general`;

		for (const nsid of [
			"social.colibri.beta.polyfill.uploadBlob",
			"social.colibri.beta.polyfill.getBlob",
		]) {
			const route = routeOf(nsid);

			expect(spaceAuthority(route, new URLSearchParams({ space: channel }), undefined)).toBe(SPACE);
			expect(spaceAuthority(route, new URLSearchParams(), undefined)).toBeUndefined();
		}
	});

	it("keeps personal spaces local without naming an authority", () => {
		const preferences = `at:space/${SPACE}/social.colibri.beta.actor.preferences/self`;
		const legacy = `at://${SPACE}/space/social.colibri.beta.actor.preferences/self`;
		const route = routeOf("social.colibri.beta.polyfill.applyWrites");

		expect(
			spaceAuthority(route, new URLSearchParams(), {
				space: preferences,
			}),
		).toBeUndefined();
		expect(
			spaceAuthority(route, new URLSearchParams({ space: legacy }), undefined),
		).toBeUndefined();
	});

	it("keeps bridge methods on the AppView the bridge talks to", () => {
		expect(routeOf("social.colibri.beta.bridge.postMessage")).toBe("local");
	});
});
