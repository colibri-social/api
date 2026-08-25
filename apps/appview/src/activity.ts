import type { ActivityKind } from "@colibri-social/appview-db";
import { PdsClient } from "@colibri-social/space";
import { eq, lte } from "drizzle-orm";
import { resolveArtwork } from "./activity-artwork.js";
import { announceToCommunities, presenceEvent } from "./announce.js";
import type { AppContext } from "./context.js";
import { presenceOf } from "./presence.js";
import { loadActivity } from "./views/activity.js";

export const TEAL_STATUS_COLLECTION = "fm.teal.actor.status";
export const ACTIVITY_SWEEP_MS = 30_000;

const SELF = "self";
const SOURCE = "teal.fm";
const LISTENING = "listening" satisfies ActivityKind;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const MAX_TEXT = 256;

type TealArtist = { artistName?: unknown };

type TealPlay = {
	trackName?: unknown;
	artists?: unknown;
	releaseName?: unknown;
	releaseMbId?: unknown;
	originUri?: unknown;
	playedTime?: unknown;
	duration?: unknown;
};

type TealStatus = { item?: unknown; time?: unknown; expiry?: unknown };

export type ActivityDraft = {
	kind: ActivityKind;
	title: string;
	subtitle: string | null;
	detail: string | null;
	linkUri: string | null;
	startedAt: string | null;
	endsAt: string | null;
	source: string;
	releaseMbId: string | null;
};

const text = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
};

const httpUrl = (value: unknown): string | undefined => {
	const raw = text(value);
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
};

const instant = (value: unknown): number | undefined => {
	const raw = text(value);
	if (!raw) return undefined;
	const parsed = Date.parse(raw);
	return Number.isNaN(parsed) ? undefined : parsed;
};

const artistNames = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => text((entry as TealArtist | null)?.artistName))
		.filter((name): name is string => name !== undefined);
};

export const readTealStatus = (record: unknown, nowMs: number): ActivityDraft | null => {
	const status = (record ?? {}) as TealStatus;
	const item = (status.item ?? {}) as TealPlay;

	const title = text(item.trackName);
	if (!title) return null;

	const wroteAt = instant(status.time) ?? nowMs;
	const startedAt = instant(item.playedTime) ?? wroteAt;
	const duration = typeof item.duration === "number" && item.duration > 0 ? item.duration : null;
	const endsAt =
		instant(status.expiry) ??
		(duration ? startedAt + duration * 1000 : wroteAt + DEFAULT_WINDOW_MS);
	if (endsAt <= nowMs) return null;

	const artists = artistNames(item.artists);

	return {
		kind: LISTENING,
		title,
		subtitle: artists.length > 0 ? artists.join(", ").slice(0, MAX_TEXT) : null,
		detail: text(item.releaseName) ?? null,
		linkUri: httpUrl(item.originUri) ?? null,
		startedAt: new Date(startedAt).toISOString(),
		endsAt: new Date(endsAt).toISOString(),
		source: SOURCE,
		releaseMbId: text(item.releaseMbId) ?? null,
	};
};

const sameTrack = (
	left: Pick<ActivityDraft, "title" | "subtitle" | "detail">,
	right: Pick<ActivityDraft, "title" | "subtitle" | "detail">,
): boolean =>
	left.title === right.title && left.subtitle === right.subtitle && left.detail === right.detail;

export const sharesActivity = async (ctx: AppContext, did: string): Promise<boolean> => {
	const [row] = await ctx.database.db
		.select({ shareActivity: ctx.database.tables.actorSettings.shareActivity })
		.from(ctx.database.tables.actorSettings)
		.where(eq(ctx.database.tables.actorSettings.did, did))
		.limit(1);
	return row?.shareActivity === true;
};

const storedActivity = async (ctx: AppContext, did: string) => {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorActivity)
		.where(eq(ctx.database.tables.actorActivity.did, did))
		.limit(1);
	return row;
};

export const announceActivity = async (ctx: AppContext, did: string): Promise<void> => {
	const [presence] = await ctx.database.db
		.select()
		.from(ctx.database.tables.userPresence)
		.where(eq(ctx.database.tables.userPresence.did, did))
		.limit(1);

	const activity = await loadActivity(ctx, did);
	const view = presenceOf(
		ctx,
		did,
		presence ?? {
			derivedState: "offline",
			requestedState: null,
			statusText: null,
			statusEmoji: null,
		},
		activity,
	);
	await announceToCommunities(ctx, did, presenceEvent(did, view));
};

export const clearActivity = async (ctx: AppContext, did: string): Promise<void> => {
	const removed = await ctx.database.db
		.delete(ctx.database.tables.actorActivity)
		.where(eq(ctx.database.tables.actorActivity.did, did))
		.returning();
	if (removed.length === 0) return;
	await announceActivity(ctx, did);
};

export const applyTealStatus = async (
	ctx: AppContext,
	did: string,
	record: unknown,
): Promise<void> => {
	if (!(await sharesActivity(ctx, did))) return;

	const draft = readTealStatus(record, Date.now());
	if (!draft) {
		await clearActivity(ctx, did);
		return;
	}

	const existing = await storedActivity(ctx, did);
	if (existing && sameTrack(existing, draft) && existing.endsAt === draft.endsAt) return;

	const reusable = existing && sameTrack(existing, draft) ? existing.imageUrl : null;
	const imageUrl =
		reusable ??
		(await resolveArtwork(
			{ cache: ctx.artwork, log: ctx.log, video: ctx.videoArtwork },
			{
				track: draft.title,
				artist: draft.subtitle ?? undefined,
				release: draft.detail ?? undefined,
				releaseMbId: draft.releaseMbId ?? undefined,
			},
		)) ??
		null;

	const row = {
		did,
		kind: draft.kind,
		title: draft.title,
		subtitle: draft.subtitle,
		detail: draft.detail,
		imageUrl,
		linkUri: draft.linkUri,
		startedAt: draft.startedAt,
		endsAt: draft.endsAt,
		source: draft.source,
		updatedAt: new Date().toISOString(),
	};

	await ctx.database.db
		.insert(ctx.database.tables.actorActivity)
		.values(row)
		.onConflictDoUpdate({ target: ctx.database.tables.actorActivity.did, set: row });

	await announceActivity(ctx, did);
};

export const backfillActivity = async (ctx: AppContext, did: string): Promise<void> => {
	if (!(await sharesActivity(ctx, did))) return;

	const pds = (await ctx.identity.resolveDid(did).catch(() => null))?.pds;
	if (!pds) return;

	const record = await new PdsClient({ service: pds })
		.getPublicRecord<{ value: unknown }>(did, TEAL_STATUS_COLLECTION, SELF)
		.then((found) => found.value)
		.catch(() => null);

	if (!record) {
		await clearActivity(ctx, did);
		return;
	}
	await applyTealStatus(ctx, did, record);
};

export const setActivitySharing = async (
	ctx: AppContext,
	did: string,
	sharing: boolean,
): Promise<void> => {
	if (!sharing) {
		await clearActivity(ctx, did);
		return;
	}
	await backfillActivity(ctx, did);
};

export const sweepLapsedActivities = async (ctx: AppContext): Promise<number> => {
	const now = new Date().toISOString();
	const lapsed = await ctx.database.db
		.select({ did: ctx.database.tables.actorActivity.did })
		.from(ctx.database.tables.actorActivity)
		.where(lte(ctx.database.tables.actorActivity.endsAt, now));

	for (const { did } of lapsed) await clearActivity(ctx, did);
	return lapsed.length;
};

export class ActivitySweeper {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly ctx: AppContext,
		private readonly intervalMs = ACTIVITY_SWEEP_MS,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void sweepLapsedActivities(this.ctx).catch((error: unknown) =>
				this.ctx.log.warn({ err: error }, "activity.sweepFailed"),
			);
		}, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}
