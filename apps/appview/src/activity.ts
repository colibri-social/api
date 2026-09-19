import { PdsClient } from "@colibri-social/space";
import { and, eq, lte } from "drizzle-orm";
import { resolveArtwork } from "./activity-artwork.js";
import { resolveGame } from "./activity-game.js";
import {
	ACTIVITY_PROVIDERS,
	type ActivityDraft,
	type ActivityProvider,
	activityProviderFor,
} from "./activity-providers.js";
import { announceToCommunities, presenceEvent } from "./announce.js";
import type { AppContext } from "./context.js";
import { presenceOf } from "./presence.js";
import { activityIsCurrent, loadActorActivities } from "./views/activity.js";

export const ACTIVITY_SWEEP_MS = 30_000;

const SELF = "self";

const queues = new Map<string, Promise<void>>();

const enqueue = (did: string, work: () => Promise<void>): Promise<void> => {
	const previous = queues.get(did) ?? Promise.resolve();
	const next = previous.then(work);
	const settled = next.catch(() => undefined);

	queues.set(did, settled);
	void settled.then(() => {
		if (queues.get(did) === settled) queues.delete(did);
	});

	return next;
};

const sameTrack = (
	left: Pick<ActivityDraft, "title" | "subtitle" | "detail">,
	right: Pick<ActivityDraft, "title" | "subtitle" | "detail">,
): boolean =>
	left.title === right.title && left.subtitle === right.subtitle && left.detail === right.detail;

const extendsWindow = (stored: string | null, incoming: string | null): boolean => {
	const next = incoming ? Date.parse(incoming) : Number.NaN;
	if (Number.isNaN(next)) return false;

	const known = stored ? Date.parse(stored) : Number.NaN;
	return Number.isNaN(known) || next > known;
};

const startedFirst = (left: ActivityDraft, right: ActivityDraft): number =>
	Date.parse(right.startedAt ?? "") - Date.parse(left.startedAt ?? "");

export const sharesActivity = async (ctx: AppContext, did: string): Promise<boolean> => {
	const [row] = await ctx.database.db
		.select({ shareActivity: ctx.database.tables.actorSettings.shareActivity })
		.from(ctx.database.tables.actorSettings)
		.where(eq(ctx.database.tables.actorSettings.did, did))
		.limit(1);
	return row?.shareActivity === true;
};

const storedActivity = async (ctx: AppContext, did: string, source: string) => {
	const [row] = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorActivity)
		.where(
			and(
				eq(ctx.database.tables.actorActivity.did, did),
				eq(ctx.database.tables.actorActivity.source, source),
			),
		)
		.limit(1);
	return row;
};

const sameTrackElsewhere = async (ctx: AppContext, did: string, draft: ActivityDraft) => {
	const rows = await ctx.database.db
		.select()
		.from(ctx.database.tables.actorActivity)
		.where(eq(ctx.database.tables.actorActivity.did, did));

	const now = Date.now();
	return rows.find(
		(row) => row.source !== draft.source && activityIsCurrent(row, now) && sameTrack(row, draft),
	);
};

const storedSources = async (ctx: AppContext, did: string): Promise<string[]> => {
	const rows = await ctx.database.db
		.select({ source: ctx.database.tables.actorActivity.source })
		.from(ctx.database.tables.actorActivity)
		.where(eq(ctx.database.tables.actorActivity.did, did));
	return rows.map((row) => row.source);
};

export const announceActivity = async (ctx: AppContext, did: string): Promise<void> => {
	const [presence] = await ctx.database.db
		.select()
		.from(ctx.database.tables.userPresence)
		.where(eq(ctx.database.tables.userPresence.did, did))
		.limit(1);

	const activities = await loadActorActivities(ctx, did);
	const view = presenceOf(
		ctx,
		did,
		presence ?? {
			derivedState: "offline",
			requestedState: null,
			statusText: null,
			statusEmoji: null,
		},
		activities,
	);
	await announceToCommunities(ctx, did, presenceEvent(did, view));
};

const removeActivity = async (ctx: AppContext, did: string, source?: string): Promise<boolean> => {
	const { db, tables } = ctx.database;
	const removed = await db
		.delete(tables.actorActivity)
		.where(
			source
				? and(eq(tables.actorActivity.did, did), eq(tables.actorActivity.source, source))
				: eq(tables.actorActivity.did, did),
		)
		.returning();
	return removed.length > 0;
};

const enrich = async (ctx: AppContext, draft: ActivityDraft): Promise<ActivityDraft> => {
	if (!draft.gameUri) return draft;

	const game = await resolveGame(
		{ cache: ctx.games, identity: ctx.identity, log: ctx.log },
		draft.gameUri,
	);
	return {
		...draft,
		title: game.title ?? draft.title,
		imageUrl: draft.imageUrl ?? game.imageUrl,
	};
};

const writeDraft = async (
	ctx: AppContext,
	did: string,
	incoming: ActivityDraft,
): Promise<boolean> => {
	const draft = await enrich(ctx, incoming);
	if (!draft.title) return false;

	const existing =
		(await storedActivity(ctx, did, draft.source)) ?? (await sameTrackElsewhere(ctx, did, draft));
	const continues = existing !== undefined && sameTrack(existing, draft);
	if (continues && !extendsWindow(existing.endsAt, draft.endsAt)) return false;

	const imageUrl =
		draft.imageUrl ??
		(continues ? existing.imageUrl : null) ??
		(draft.searchArtwork
			? ((await resolveArtwork(
					{ cache: ctx.artwork, log: ctx.log, video: ctx.videoArtwork },
					{
						track: draft.title,
						artist: draft.subtitle ?? undefined,
						release: draft.detail ?? undefined,
						releaseMbId: draft.releaseMbId ?? undefined,
					},
				)) ?? null)
			: null);

	const row = {
		did,
		kind: draft.kind,
		title: draft.title,
		subtitle: draft.subtitle,
		detail: draft.detail,
		imageUrl,
		linkUri: continues ? (existing.linkUri ?? draft.linkUri) : draft.linkUri,
		startedAt: continues ? (existing.startedAt ?? draft.startedAt) : draft.startedAt,
		endsAt: draft.endsAt,
		source: continues ? existing.source : draft.source,
		updatedAt: new Date().toISOString(),
	};

	await ctx.database.db
		.insert(ctx.database.tables.actorActivity)
		.values(row)
		.onConflictDoUpdate({
			target: [ctx.database.tables.actorActivity.did, ctx.database.tables.actorActivity.source],
			set: row,
		});

	return true;
};

const currentRecord = async (
	client: PdsClient,
	did: string,
	provider: ActivityProvider,
): Promise<unknown> => {
	if (provider.locate === "newest") {
		const page = await client
			.listPublicRecords<unknown>(did, provider.collection, { limit: 1 })
			.catch(() => null);
		return page?.records[0]?.value ?? null;
	}

	return await client
		.getPublicRecord<{ value: unknown }>(did, provider.collection, SELF)
		.then((found) => found.value)
		.catch(() => null);
};

const refill = async (ctx: AppContext, did: string, skipSource?: string): Promise<boolean> => {
	const pds = (await ctx.identity.resolveDid(did).catch(() => null))?.pds;
	if (!pds) return false;

	const client = new PdsClient({ service: pds });
	const now = Date.now();
	const drafts: ActivityDraft[] = [];

	for (const provider of ACTIVITY_PROVIDERS) {
		if (provider.source === skipSource) continue;

		const record = await currentRecord(client, did, provider);
		if (!record) continue;

		const draft = provider.read(record, now);
		if (draft) drafts.push(draft);
	}

	let changed = false;
	const filled = new Set<string>();

	for (const draft of drafts.sort(startedFirst)) {
		if (filled.has(draft.source)) continue;
		filled.add(draft.source);
		if (await writeDraft(ctx, did, draft)) changed = true;
	}

	for (const source of await storedSources(ctx, did)) {
		if (source === skipSource || filled.has(source)) continue;
		if (await removeActivity(ctx, did, source)) changed = true;
	}

	return changed;
};

export const clearActivity = (ctx: AppContext, did: string): Promise<void> =>
	enqueue(did, async () => {
		if (!(await removeActivity(ctx, did))) return;
		await announceActivity(ctx, did);
	});

export const clearActivityFrom = (ctx: AppContext, did: string, source: string): Promise<void> =>
	enqueue(did, async () => {
		if (!(await removeActivity(ctx, did, source))) return;
		await refill(ctx, did, source);
		await announceActivity(ctx, did);
	});

export const applyActivityRecord = (
	ctx: AppContext,
	did: string,
	collection: string,
	record: unknown,
): Promise<void> =>
	enqueue(did, async () => {
		const provider = activityProviderFor(collection);
		if (!provider) return;
		if (!(await sharesActivity(ctx, did))) return;

		const draft = provider.read(record, Date.now());
		if (!draft) {
			if (!(await removeActivity(ctx, did, provider.source))) return;
			await refill(ctx, did, provider.source);
			await announceActivity(ctx, did);
			return;
		}

		if (await writeDraft(ctx, did, draft)) await announceActivity(ctx, did);
	});

export const backfillActivity = (ctx: AppContext, did: string): Promise<void> =>
	enqueue(did, async () => {
		if (!(await sharesActivity(ctx, did))) return;
		if (await refill(ctx, did)) await announceActivity(ctx, did);
	});

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

const removeLapsed = (ctx: AppContext, did: string, now: string): Promise<void> =>
	enqueue(did, async () => {
		const { db, tables } = ctx.database;
		const removed = await db
			.delete(tables.actorActivity)
			.where(and(eq(tables.actorActivity.did, did), lte(tables.actorActivity.endsAt, now)))
			.returning();
		if (removed.length === 0) return;
		await announceActivity(ctx, did);
	});

export const sweepLapsedActivities = async (ctx: AppContext): Promise<number> => {
	const now = new Date().toISOString();
	const lapsed = await ctx.database.db
		.select({ did: ctx.database.tables.actorActivity.did })
		.from(ctx.database.tables.actorActivity)
		.where(lte(ctx.database.tables.actorActivity.endsAt, now));

	const dids = [...new Set(lapsed.map((row) => row.did))];
	for (const did of dids) await removeLapsed(ctx, did, now);
	return dids.length;
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
