import { describe, expect, it } from "vitest";
import { containsHeadClose, extractMetaTags, extractTitleTag } from "./html.js";

describe("extractMetaTags", () => {
	it("reads property and name attributes regardless of order", () => {
		const html = `
			<meta content="Ordered second" property="og:title" />
			<meta name="twitter:title" content="Ordered first" />
		`;
		const metas = extractMetaTags(html);
		expect(metas.get("og:title")).toBe("Ordered second");
		expect(metas.get("twitter:title")).toBe("Ordered first");
	});

	it("handles single and double quoted attributes", () => {
		const html = `<meta property='og:title' content='Single quoted' /><meta property="og:description" content="Double quoted" />`;
		const metas = extractMetaTags(html);
		expect(metas.get("og:title")).toBe("Single quoted");
		expect(metas.get("og:description")).toBe("Double quoted");
	});

	it("decodes named and numeric html entities in content", () => {
		const html = `<meta property="og:title" content="Fish &amp; Chips &#39;quoted&#39; &#x2014; dash" />`;
		const metas = extractMetaTags(html);
		expect(metas.get("og:title")).toBe("Fish & Chips 'quoted' — dash");
	});

	it("keeps the first occurrence of a repeated key", () => {
		const html = `
			<meta property="og:video" content="https://example.com/a.mp4" />
			<meta property="og:video" content="https://example.com/a.webm" />
		`;
		const metas = extractMetaTags(html);
		expect(metas.get("og:video")).toBe("https://example.com/a.mp4");
	});

	it("lowercases keys and trims content, dropping empty content", () => {
		const html = `<meta PROPERTY="OG:Title" content="  padded  " /><meta property="og:empty" content="   " />`;
		const metas = extractMetaTags(html);
		expect(metas.get("og:title")).toBe("padded");
		expect(metas.has("og:empty")).toBe(false);
	});

	it("ignores meta tags without both a key and content", () => {
		const html = `<meta property="og:title" /><meta content="orphan content" />`;
		const metas = extractMetaTags(html);
		expect(metas.size).toBe(0);
	});
});

describe("extractTitleTag", () => {
	it("extracts and trims the title text", () => {
		expect(extractTitleTag("<html><head><title>  Just A Title  </title></head></html>")).toBe(
			"Just A Title",
		);
	});

	it("decodes entities inside the title", () => {
		expect(extractTitleTag("<title>Fish &amp; Chips</title>")).toBe("Fish & Chips");
	});

	it("returns undefined when there is no title tag or it is empty", () => {
		expect(extractTitleTag("<html><head></head></html>")).toBeUndefined();
		expect(extractTitleTag("<title></title>")).toBeUndefined();
	});
});

describe("containsHeadClose", () => {
	it("detects a closing head tag regardless of case or whitespace", () => {
		expect(containsHeadClose(Buffer.from("<head></head>"))).toBe(true);
		expect(containsHeadClose(Buffer.from("<head></HEAD >"))).toBe(true);
	});

	it("returns false when there is no closing head tag yet", () => {
		expect(containsHeadClose(Buffer.from("<head><title>still going"))).toBe(false);
	});
});
