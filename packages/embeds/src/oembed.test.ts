import { describe, expect, it } from "vitest";
import { findOEmbedUrl, oEmbedFields } from "./oembed.js";

describe("oEmbed", () => {
	it("finds the json+oembed alternate link", () => {
		const url = findOEmbedUrl(
			[
				{ rel: ["icon"], href: "/favicon.png" },
				{ rel: ["alternate"], type: "application/json+oembed", href: "/owoembed?status=1" },
			],
			new URL("https://fixupx.com/a/status/1"),
		);
		expect(url).toBe("https://fixupx.com/owoembed?status=1");
	});

	it("maps provider and author", () => {
		expect(
			oEmbedFields({
				author_name: "Jane Doe",
				author_url: "https://example.com/jane",
				provider_name: "Example",
				provider_url: "https://example.com",
			}),
		).toEqual({
			author: { name: "Jane Doe", url: "https://example.com/jane" },
			provider: { name: "Example", url: "https://example.com/" },
		});
	});

	it("treats multi-line author names as body text", () => {
		expect(oEmbedFields({ author_name: "\n\nQuoting Frank\n\nhello" })).toEqual({
			text: "Quoting Frank\n\nhello",
		});
	});

	it("ignores invalid payloads", () => {
		expect(oEmbedFields({ author_name: 4 })).toBeUndefined();
	});
});
