import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { createTtlCache, type TtlCache } from "@colibri-social/embeds";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyTealStatus,
	clearActivity,
	readTealStatus,
	setActivitySharing,
	sweepLapsedActivities,
} from "./activity.js";
import { type ArtworkEntry, artworkCacheKey } from "./activity-artwork.js";
import type { AppContext } from "./context.js";
import { loadActivity } from "./views/activity.js";
import type { ServerFrame } from "./ws/events.js";

const ACTOR = "did:plc:listeneraaaaaaaaaaaaaaaaaa";
const COMMUNITY = "did:plc:communityaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-08-25T13:20:00.000Z");

const PLAY = {
	trackName: "Sick Like You",
	artists: [{ artistName: "Jaira Burns", artistMbId: "mbid:a6bf06a6-756f-4639-b8c0-0960a8d6cc0a" }],
	releaseName: "Hard To Love",
	releaseMbId: "mbid:fcdb5202-27a2-4500-90c6-5264a2cd2756",
	originUri: "https://www.last.fm/music/Jaira+Burns/_/Sick+Like+You",
	playedTime: "2026-08-25T13:18:51Z",
	duration: 140,
} as const;

const status = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	$type: "fm.teal.actor.status",
	item,
	time: "2026-08-25T13:19:00Z",
	...extra,
});

let database: TestDatabase;
let artwork: TtlCache<ArtworkEntry>;
let announced: Array<{ to: string; frame: ServerFrame }>;
let ctx: AppContext;

const seedArtwork = (url: string | null) => {
	artwork.set(
		artworkCacheKey({
			track: PLAY.trackName,
			artist: PLAY.artists[0].artistName,
			release: PLAY.releaseName,
			releaseMbId: PLAY.releaseMbId,
		}),
		{ url },
	);
};

const sharing = async (shareActivity: boolean) => {
	await database.db
		.insert(database.tables.actorSettings)
		.values({ did: ACTOR, shareActivity })
		.onConflictDoUpdate({ target: database.tables.actorSettings.did, set: { shareActivity } });
};

const storedRow = async () => {
	const [row] = await database.db
		.select()
		.from(database.tables.actorActivity)
		.where(eq(database.tables.actorActivity.did, ACTOR))
		.limit(1);
	return row;
};

const activities = () =>
	announced.map(
		(entry) => (entry.frame.presence as { activity?: { title: string } } | undefined)?.activity,
	);

beforeEach(async () => {
	database = await openTestDatabase();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	artwork = createTtlCache<ArtworkEntry>();
	announced = [];
	ctx = {
		announce: {
			toUser: (did: string, frame: ServerFrame) => announced.push({ to: did, frame }),
			toCommunity: (community: string, frame: ServerFrame) =>
				announced.push({ to: community, frame }),
		},
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "abcdef0123456789" },
		database,
		artwork,
		voice: null,
		log: { warn: () => undefined, debug: () => undefined },
	} as unknown as AppContext;

	await database.db
		.insert(database.tables.members)
		.values({ did: ACTOR, community: COMMUNITY, roles: [], joinedAt: "2026-08-01T00:00:00.000Z" });
});

afterEach(async () => {
	vi.useRealTimers();
	await database.destroy();
});

describe("readTealStatus", () => {
	it("reads a play into an activity", () => {
		expect(readTealStatus(status(PLAY), NOW)).toEqual({
			kind: "listening",
			title: "Sick Like You",
			subtitle: "Jaira Burns",
			detail: "Hard To Love",
			linkUri: "https://www.last.fm/music/Jaira+Burns/_/Sick+Like+You",
			startedAt: "2026-08-25T13:18:51.000Z",
			endsAt: "2026-08-25T13:21:11.000Z",
			source: "teal.fm",
			releaseMbId: "mbid:fcdb5202-27a2-4500-90c6-5264a2cd2756",
		});
	});

	it("joins every artist named on the play", () => {
		const many = readTealStatus(
			status({ ...PLAY, artists: [{ artistName: "One" }, { artistName: "Two" }] }),
			NOW,
		);
		expect(many?.subtitle).toBe("One, Two");
	});

	it("reads nothing from the empty status teal.fm writes when playback stops", () => {
		expect(
			readTealStatus(
				status({ trackName: "", artists: [] }, { expiry: "2026-08-25T13:19:00Z" }),
				NOW,
			),
		).toBeNull();
	});

	it("reads nothing from a status that has already lapsed", () => {
		expect(readTealStatus(status(PLAY, { expiry: "2026-08-25T13:19:59Z" }), NOW)).toBeNull();
	});

	it("prefers the expiry the record names over the track length", () => {
		const draft = readTealStatus(status(PLAY, { expiry: "2026-08-25T13:25:00Z" }), NOW);
		expect(draft?.endsAt).toBe("2026-08-25T13:25:00.000Z");
	});

	it("falls back to ten minutes when neither an expiry nor a length is given", () => {
		const draft = readTealStatus(
			status({ trackName: "Untitled", artists: [] }, { time: "2026-08-25T13:19:00Z" }),
			NOW,
		);
		expect(draft?.endsAt).toBe("2026-08-25T13:29:00.000Z");
		expect(draft?.subtitle).toBeNull();
	});

	it("drops a link that is not http", () => {
		const draft = readTealStatus(status({ ...PLAY, originUri: "javascript:alert(1)" }), NOW);
		expect(draft?.linkUri).toBeNull();
	});
});

describe("applyTealStatus", () => {
	it("ignores a status from someone who does not share their listening", async () => {
		await sharing(false);
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		expect(await storedRow()).toBeUndefined();
		expect(announced).toHaveLength(0);
	});

	it("stores the track and tells the actor's communities", async () => {
		await sharing(true);
		seedArtwork("https://coverartarchive.org/release/fcdb5202/front-500");
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		expect((await storedRow())?.title).toBe("Sick Like You");
		expect(announced.map((entry) => entry.to)).toEqual([ACTOR, COMMUNITY]);
		expect(activities()[0]?.title).toBe("Sick Like You");
	});

	it("serves the artwork through this appview rather than the origin", async () => {
		await sharing(true);
		seedArtwork("https://coverartarchive.org/release/fcdb5202/front-500");
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		const activity = await loadActivity(ctx, ACTOR);
		expect(activity?.imageUri).toContain(
			"https://appview.test/xrpc/social.colibri.beta.embed.getImage",
		);
		expect(activity?.imageUri).toContain("sig=");
	});

	it("leaves the artwork out when none could be found", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		expect((await storedRow())?.imageUrl).toBeNull();
		expect((await loadActivity(ctx, ACTOR))?.imageUri).toBeUndefined();
	});

	it("says nothing when the same track is written again", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));
		announced = [];
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		expect(announced).toHaveLength(0);
	});

	it("clears the activity when playback stops", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));
		announced = [];

		await applyTealStatus(
			ctx,
			ACTOR,
			status({ trackName: "", artists: [] }, { expiry: "2026-08-25T13:19:00Z" }),
		);

		expect(await storedRow()).toBeUndefined();
		expect(activities()[0]).toBeUndefined();
		expect(announced).toHaveLength(2);
	});
});

describe("loadActivity", () => {
	it("hides an activity from someone who stopped sharing", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));
		await sharing(false);

		expect(await loadActivity(ctx, ACTOR)).toBeUndefined();
	});

	it("hides an activity that has lapsed", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY, { expiry: "2026-08-25T13:25:00Z" }));

		await database.db
			.update(database.tables.actorActivity)
			.set({ endsAt: "2020-01-01T00:00:00.000Z" })
			.where(eq(database.tables.actorActivity.did, ACTOR));

		expect(await loadActivity(ctx, ACTOR)).toBeUndefined();
	});
});

describe("clearing", () => {
	it("says nothing when there was nothing to clear", async () => {
		await clearActivity(ctx, ACTOR);
		expect(announced).toHaveLength(0);
	});

	it("drops the activity of someone who turns sharing off", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));

		await setActivitySharing(ctx, ACTOR, false);
		expect(await storedRow()).toBeUndefined();
	});

	it("sweeps up an activity that lapsed while nothing was written", async () => {
		await sharing(true);
		seedArtwork(null);
		await applyTealStatus(ctx, ACTOR, status(PLAY));
		await database.db
			.update(database.tables.actorActivity)
			.set({ endsAt: "2020-01-01T00:00:00.000Z" })
			.where(eq(database.tables.actorActivity.did, ACTOR));

		expect(await sweepLapsedActivities(ctx)).toBe(1);
		expect(await storedRow()).toBeUndefined();
	});
});
