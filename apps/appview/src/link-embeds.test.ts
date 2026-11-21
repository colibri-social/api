import { openTestDatabase } from "@colibri-social/appview-db";
import { createTtlCache, type GifView, type LinkEmbed } from "@colibri-social/embeds";
import { describe, expect, it } from "vitest";
import {
	createLinkEmbedResolver,
	klipySlugOf,
	linkUrisOf,
	MAX_EMBEDS_PER_MESSAGE,
} from "./link-embeds.js";
import type { Logger } from "./logger.js";
import { drizzleStoredPreviews } from "./stores.js";

const log = { debug: () => {} } as unknown as Logger;

const link = (uri: string) => ({
	index: { byteStart: 0, byteEnd: 1 },
	features: [{ $type: "social.colibri.beta.richtext.facet#link", uri }],
});

const deferred = () => {
	let release: (embed: LinkEmbed) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const promise = new Promise<LinkEmbed>((resolve, reject) => {
		release = resolve;
		fail = reject;
	});
	return { promise, release, fail };
};

const tenor = "https://tenor.com/view/touhou-fumo-plushie-plush-hello-gif-21004226";

describe("linkUrisOf", () => {
	it("collects web links once, in order, skipping suppressed and non-link features", () => {
		const facets = [
			link("https://a.test/"),
			{ features: [{ $type: "social.colibri.beta.richtext.facet#mention", did: "did:plc:x" }] },
			link("https://b.test/"),
			link("https://a.test/"),
			link("mailto:someone@example.com"),
			link("https://hidden.test/"),
		];

		expect(linkUrisOf(facets, ["https://hidden.test/"])).toEqual([
			"https://a.test/",
			"https://b.test/",
		]);
	});

	it("caps the number of links per message", () => {
		const facets = Array.from({ length: MAX_EMBEDS_PER_MESSAGE + 3 }, (_, i) =>
			link(`https://site${i}.test/`),
		);

		expect(linkUrisOf(facets, null)).toHaveLength(MAX_EMBEDS_PER_MESSAGE);
	});

	it("tolerates missing or malformed facets", () => {
		expect(linkUrisOf(null, null)).toEqual([]);
		expect(linkUrisOf([{}, { features: [null] }], undefined)).toEqual([]);
	});
});

describe("createLinkEmbedResolver", () => {
	it("returns previews that settle within the wait budget", async () => {
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			fetchPreview: async (uri) => ({ uri, siteName: "Tenor" }),
		});

		const found = await resolver.resolve([tenor], 1_000);

		expect(found.get(tenor)).toEqual({ uri: tenor, siteName: "Tenor" });
		expect(resolver.peek(tenor)).toEqual({ uri: tenor, siteName: "Tenor" });
	});

	it("returns without slow previews and settles them in the background", async () => {
		const pending = deferred();
		let calls = 0;
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			fetchPreview: () => {
				calls += 1;
				return pending.promise;
			},
		});

		expect((await resolver.resolve([tenor], 0)).size).toBe(0);
		expect((await resolver.resolve([tenor], 0)).size).toBe(0);
		expect(calls).toBe(1);

		pending.release({ uri: tenor, title: "Touhou Fumo GIF" });
		await resolver.settle([tenor]);

		expect(resolver.peek(tenor)?.title).toBe("Touhou Fumo GIF");
	});

	it("keeps a preview across a new resolver on the same database", async () => {
		const database = await openTestDatabase();
		try {
			let calls = 0;
			const fetchPreview = async (uri: string) => {
				calls += 1;
				return { uri, siteName: "Tenor" };
			};
			const first = createLinkEmbedResolver({
				cache: createTtlCache<LinkEmbed>(),
				log,
				stored: drizzleStoredPreviews(database),
				fetchPreview,
			});
			await first.resolve([tenor], 1_000);

			const second = createLinkEmbedResolver({
				cache: createTtlCache<LinkEmbed>(),
				log,
				stored: drizzleStoredPreviews(database),
				fetchPreview,
			});
			const found = await second.resolve([tenor], 0);

			expect(found.get(tenor)).toEqual({ uri: tenor, siteName: "Tenor" });
			expect(calls).toBe(1);
		} finally {
			await database.destroy();
		}
	});

	it("fetches again once a stored preview is a week old", async () => {
		const database = await openTestDatabase();
		try {
			let now = Date.parse("2026-10-01T00:00:00.000Z");
			await drizzleStoredPreviews(database, () => now).save(tenor, { uri: tenor, title: "old" });
			now += 8 * 24 * 60 * 60 * 1000;

			const loaded = await drizzleStoredPreviews(database, () => now).load([tenor]);

			expect(loaded.size).toBe(0);
		} finally {
			await database.destroy();
		}
	});

	it("does not refetch a failed link until the miss expires", async () => {
		let now = 0;
		let calls = 0;
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			now: () => now,
			fetchPreview: async () => {
				calls += 1;
				throw new Error("unreachable");
			},
		});

		await resolver.resolve(["https://down.test/"], 1_000);
		await resolver.resolve(["https://down.test/"], 1_000);
		expect(calls).toBe(1);

		now = 10 * 60 * 1000;
		await resolver.resolve(["https://down.test/"], 1_000);
		expect(calls).toBe(2);
	});

	it("turns direct video links into a video embed without fetching the page", async () => {
		let calls = 0;
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			fetchPreview: async (uri) => {
				calls += 1;
				return { uri };
			},
		});
		const clip = "https://media.tenor.com/UdX-_wwJpGIAAAPo/touhou-fumo.mp4";

		const found = await resolver.resolve([clip], 1_000);

		expect(found.get(clip)).toEqual({ uri: clip, video: { url: clip, mimeType: "video/mp4" } });
		expect(calls).toBe(0);
	});

	it("resolves klipy gif pages through the gif lookup without fetching the page", async () => {
		const page = "https://klipy.com/gifs/cat-the-voices-2";
		const slugs: string[] = [];
		let calls = 0;
		const gif: GifView = {
			id: "cat-the-voices-2",
			url: "https://static.klipy.com/md.gif",
			previewUrl: "https://static.klipy.com/sm.webp",
			width: 457,
			height: 498,
			title: "Jolly Christmas Cat Voices",
		};
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			gifs: {
				gifBySlug: async (slug) => {
					slugs.push(slug);
					return gif;
				},
			},
			fetchPreview: async (uri) => {
				calls += 1;
				return { uri };
			},
		});

		const found = await resolver.resolve([page], 1_000);

		expect(found.get(page)).toEqual({
			uri: page,
			image: { url: gif.url, width: 457, height: 498 },
			title: "Jolly Christmas Cat Voices",
		});
		expect(slugs).toEqual(["cat-the-voices-2"]);
		expect(calls).toBe(0);
	});

	it("records a miss for an unknown klipy slug", async () => {
		let now = 0;
		let lookups = 0;
		let calls = 0;
		const page = "https://www.klipy.com/gifs/gone";
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			now: () => now,
			gifs: {
				gifBySlug: async () => {
					lookups += 1;
					return undefined;
				},
			},
			fetchPreview: async (uri) => {
				calls += 1;
				return { uri };
			},
		});

		await resolver.resolve([page], 1_000);
		await resolver.resolve([page], 1_000);
		expect(resolver.peek(page)).toBeUndefined();
		expect(lookups).toBe(1);
		expect(calls).toBe(0);

		now = 10 * 60 * 1000;
		await resolver.resolve([page], 1_000);
		expect(lookups).toBe(2);
	});

	it("falls back to the page fetch for klipy links when gifs are disabled", async () => {
		let calls = 0;
		const page = "https://klipy.com/gifs/cat-the-voices-2";
		const resolver = createLinkEmbedResolver({
			cache: createTtlCache<LinkEmbed>(),
			log,
			gifs: null,
			fetchPreview: async (uri) => {
				calls += 1;
				return { uri };
			},
		});

		await resolver.resolve([page], 1_000);

		expect(calls).toBe(1);
	});
});

describe("klipySlugOf", () => {
	it("reads the slug from klipy gif page links", () => {
		expect(klipySlugOf("https://klipy.com/gifs/cat-the-voices-2")).toBe("cat-the-voices-2");
		expect(klipySlugOf("https://www.klipy.com/gifs/cat-the-voices-2/")).toBe("cat-the-voices-2");
		expect(klipySlugOf("https://klipy.com/de/gifs/Hello-Hi-662?ref=x")).toBe("hello-hi-662");
	});

	it("ignores other klipy pages and other hosts", () => {
		expect(klipySlugOf("https://klipy.com/stickers/cat")).toBeUndefined();
		expect(klipySlugOf("https://klipy.com/gifs/")).toBeUndefined();
		expect(klipySlugOf("https://notklipy.com/gifs/cat")).toBeUndefined();
		expect(klipySlugOf("https://static.klipy.com/gifs/cat")).toBeUndefined();
		expect(klipySlugOf("not a url")).toBeUndefined();
	});
});
