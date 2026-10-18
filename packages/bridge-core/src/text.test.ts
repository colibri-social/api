import { describe, expect, it } from "vitest";
import { colibriToMarkdown, markdownToColibri } from "./text.js";

const kindOf = (feature: { $type?: string }): string => (feature.$type ?? "").split("#")[1] ?? "";

const links = (markdown: string) => {
	const { text, facets } = markdownToColibri(markdown);
	const bytes = new TextEncoder().encode(text);
	return facets.flatMap((facet) =>
		facet.features
			.filter((feature) => kindOf(feature) === "link")
			.map((feature) => ({
				byteStart: facet.index.byteStart,
				byteEnd: facet.index.byteEnd,
				label: new TextDecoder().decode(bytes.subarray(facet.index.byteStart, facet.index.byteEnd)),
				uri: "uri" in feature ? feature.uri : undefined,
			})),
	);
};

describe("bare URLs", () => {
	it("turns a bare URL into a link facet", () => {
		const { text } = markdownToColibri("see https://example.com/a?b=1 for more");
		expect(text).toBe("see https://example.com/a?b=1 for more");
		expect(links("see https://example.com/a?b=1 for more")).toEqual([
			{
				byteStart: 4,
				byteEnd: 29,
				label: "https://example.com/a?b=1",
				uri: "https://example.com/a?b=1",
			},
		]);
	});

	it("covers the whole message when it is a lone GIF URL", () => {
		const gif = "https://static.klipy.com/ii/abc/9f/39/X.gif";
		const { text, facets } = markdownToColibri(gif);
		expect(text).toBe(gif);
		expect(facets).toHaveLength(1);
		expect(links(gif)).toEqual([{ byteStart: 0, byteEnd: gif.length, label: gif, uri: gif }]);
	});

	it("leaves URLs in inline code and code blocks alone", () => {
		const { facets } = markdownToColibri("`https://a.test` and\n```\nhttps://b.test\n```");
		expect(facets.flatMap((facet) => facet.features.map(kindOf))).toEqual(["code", "codeblock"]);
	});

	it("keeps trailing punctuation out of the link", () => {
		expect(links("go (https://a.test/x), ok.").map(({ label, uri }) => [label, uri])).toEqual([
			["https://a.test/x", "https://a.test/x"],
		]);
		expect(links("look at https://a.test/x!").map(({ uri }) => uri)).toEqual(["https://a.test/x"]);
	});

	it("counts UTF-8 bytes around an emoji", () => {
		expect(links("🎉 https://a.test/é done")).toEqual([
			{ byteStart: 5, byteEnd: 22, label: "https://a.test/é", uri: "https://a.test/é" },
		]);
	});

	it("keeps spoiler markers out of the link", () => {
		expect(links("||https://a.test/x|| y").map(({ label, uri }) => [label, uri])).toEqual([
			["https://a.test/x", "https://a.test/x"],
		]);
	});

	it("ignores www and email literals", () => {
		expect(links("www.example.com and me@example.com")).toEqual([]);
	});

	it("keeps explicit links as they were", () => {
		expect(
			links("[https://a.test](https://a.test) and [x](https://b.test) <https://c.test>").map(
				({ label, uri }) => [label, uri],
			),
		).toEqual([
			["https://a.test", "https://a.test"],
			["x", "https://b.test"],
			["https://c.test", "https://c.test"],
		]);
	});

	it("writes a bare URL back as a self-labelled link", () => {
		const { text, facets } = markdownToColibri("hi https://a.test/x");
		expect(colibriToMarkdown(text, facets)).toBe("hi [https://a.test/x](https://a.test/x)");
	});
});
