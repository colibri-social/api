import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { toLinkEmbedView } from "./embed.js";

const ctx = {
	config: {
		PUBLIC_URL: "https://api.example.com",
		SIGNING_KEY: "f".repeat(64),
	},
} as unknown as Pick<AppContext, "config">;

describe("toLinkEmbedView", () => {
	it("repairs a stored span that ends in half a surrogate pair", () => {
		const view = toLinkEmbedView(ctx, {
			uri: "https://x.com/a/status/1",
			post: {
				body: [{ kind: "paragraph", spans: [{ text: "hi \ud83d" }] }],
			},
		});

		const text = view.post?.body[0]?.spans[0]?.text ?? "";

		expect(text.isWellFormed()).toBe(true);
		expect(text.startsWith("hi ")).toBe(true);
	});
});
