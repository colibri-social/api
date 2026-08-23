import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createGifsClient } from "./gifs.js";

let agent: MockAgent | undefined;

afterEach(async () => {
	if (agent) {
		await agent.close();
		agent = undefined;
	}
});

function newMockAgent(): MockAgent {
	agent = new MockAgent();
	agent.disableNetConnect();
	return agent;
}

describe("createGifsClient", () => {
	it("returns null when no api key is configured", () => {
		expect(createGifsClient({})).toBeNull();
		expect(createGifsClient({ apiKey: "   " })).toBeNull();
	});

	it("normalizes a paginated search response into gifView items and a next cursor", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({
				path: "/api/v1/secret/gifs/search",
				method: "GET",
				query: { q: "cats", page: "1", per_page: "50" },
			})
			.reply(200, {
				data: {
					data: [
						{
							id: 123,
							slug: "happy-dance-abc",
							title: "happy dance",
							file: {
								hd: { gif: { url: "https://cdn/hd.gif", width: 480, height: 360 } },
								md: { gif: { url: "https://cdn/md.gif", width: 320, height: 240 } },
								sm: { gif: { url: "https://cdn/sm.gif", width: 160, height: 120 } },
							},
						},
					],
					current_page: 1,
					has_next: true,
				},
			});

		const client = createGifsClient({ apiKey: "secret", dispatcher: mockAgent, pageCache: null });
		if (!client) throw new Error("client should be configured");

		const page = await client.searchGifs("cats");
		expect(page.gifs).toEqual([
			{
				id: "happy-dance-abc",
				url: "https://cdn/md.gif",
				previewUrl: "https://cdn/sm.gif",
				width: 320,
				height: 240,
				title: "happy dance",
			},
		]);
		expect(page.cursor).toBe("2");
	});

	it("drops items that have neither width nor height, which the lexicon requires", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({
				path: "/api/v1/secret/gifs/trending",
				method: "GET",
				query: { page: "1", per_page: "50" },
			})
			.reply(200, {
				data: {
					data: [{ id: "only-id", url: "https://cdn/fallback.gif", file: {} }],
					has_next: false,
				},
			});

		const client = createGifsClient({ apiKey: "secret", dispatcher: mockAgent, pageCache: null });
		if (!client) throw new Error("client should be configured");

		const page = await client.trendingGifs();
		expect(page.gifs).toEqual([]);
		expect(page.cursor).toBeUndefined();
	});

	it("parses a cursor back into the requested page", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({
				path: "/api/v1/secret/gifs/trending",
				method: "GET",
				query: { page: "3", per_page: "10" },
			})
			.reply(200, { data: { data: [], current_page: 3, has_next: false } });

		const client = createGifsClient({ apiKey: "secret", dispatcher: mockAgent, pageCache: null });
		if (!client) throw new Error("client should be configured");

		const page = await client.trendingGifs({ cursor: "3", limit: 10 });
		expect(page.gifs).toEqual([]);
	});

	it("normalizes categories from data.categories", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({ path: "/api/v1/secret/gifs/categories", method: "GET" })
			.reply(200, {
				data: {
					categories: [
						{ category: "hello", preview_url: "https://cdn/hello.gif" },
						{ category: "happy birthday" },
					],
				},
			});

		const client = createGifsClient({
			apiKey: "secret",
			dispatcher: mockAgent,
			categoryCache: null,
		});
		if (!client) throw new Error("client should be configured");

		const categories = await client.gifCategories();
		expect(categories).toEqual([
			{ name: "hello", previewUrl: "https://cdn/hello.gif" },
			{ name: "happy birthday" },
		]);
	});

	it("surfaces an upstream failure when klipy returns a non-success status", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({ path: "/api/v1/secret/gifs/search", method: "GET" })
			.reply(500, "boom");

		const client = createGifsClient({ apiKey: "secret", dispatcher: mockAgent, pageCache: null });
		if (!client) throw new Error("client should be configured");

		await expect(client.searchGifs("cats")).rejects.toMatchObject({ code: "UpstreamFailure" });
	});

	it("caches a page result so a repeat call does not hit klipy again", async () => {
		const mockAgent = newMockAgent();
		mockAgent
			.get("https://api.klipy.com")
			.intercept({
				path: "/api/v1/secret/gifs/trending",
				method: "GET",
				query: { page: "1", per_page: "50" },
			})
			.reply(200, { data: { data: [], current_page: 1, has_next: false } });

		const client = createGifsClient({ apiKey: "secret", dispatcher: mockAgent });
		if (!client) throw new Error("client should be configured");

		await client.trendingGifs();
		await client.trendingGifs();

		mockAgent.assertNoPendingInterceptors();
	});
});
