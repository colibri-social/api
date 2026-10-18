import { describe, expect, it } from "vitest";
import { htmlToRichBlocks, richBlocksText } from "./richtext.js";

describe("htmlToRichBlocks", () => {
	it("keeps quotes, bold links and line breaks from FxEmbed status content", () => {
		const html =
			'<br><br><blockquote><b><a href="https://x.com/a/status/1">Quoting</a> Frank (<a href="https://x.com/frank">@frank</a>)</b><br>︀<br>Outlook has gone crazy</blockquote><b>&#x1F4AC; 18&ensp;&#x1F501; 42</b>';
		expect(htmlToRichBlocks(html)).toEqual([
			{
				kind: "quote",
				spans: [
					{ text: "Quoting", bold: true, href: "https://x.com/a/status/1" },
					{ text: " Frank (", bold: true },
					{ text: "@frank", bold: true, href: "https://x.com/frank" },
					{ text: ")", bold: true },
					{ text: "\n︀\nOutlook has gone crazy" },
				],
			},
			{ kind: "paragraph", spans: [{ text: "\u{1F4AC} 18 \u{1F501} 42", bold: true }] },
		]);
	});

	it("splits paragraphs and drops Mastodon invisible spans", () => {
		const html =
			'<p>One <a href="https://example.com/long/path"><span class="invisible">https://</span><span>example.com/long</span><span class="invisible">/path</span></a></p><p><em>Two</em></p>';
		expect(htmlToRichBlocks(html)).toEqual([
			{
				kind: "paragraph",
				spans: [
					{ text: "One " },
					{ text: "example.com/long", href: "https://example.com/long/path" },
				],
			},
			{ kind: "paragraph", spans: [{ text: "Two", italic: true }] },
		]);
	});

	it("never carries markup or unsafe links through", () => {
		const html =
			'<p><script>alert(1)</script><img src=x onerror="alert(1)">&lt;b&gt;hi&lt;/b&gt; <a href="javascript:alert(1)">click</a></p>';
		expect(htmlToRichBlocks(html)).toEqual([
			{ kind: "paragraph", spans: [{ text: "<b>hi</b> click" }] },
		]);
	});

	it("caps the text length", () => {
		const blocks = htmlToRichBlocks(`<p>${"a".repeat(50)}</p>`, 10);
		expect(richBlocksText(blocks)).toBe(`${"a".repeat(10)}...`);
	});
});
