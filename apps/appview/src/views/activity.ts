import { asDatetime, asUri, type social } from "@colibri-social/lexicons";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { embedMediaUrl } from "../embed-token.js";

export type ActivityView = social.colibri.beta.actor.defs.Activity;

export type ActivityRow = {
	kind: string;
	title: string;
	subtitle: string | null;
	detail: string | null;
	imageUrl: string | null;
	linkUri: string | null;
	startedAt: string | null;
	endsAt: string | null;
	source: string;
};

export const activityIsCurrent = (row: Pick<ActivityRow, "endsAt">, nowMs: number): boolean => {
	if (!row.endsAt) return true;
	const endsAt = Date.parse(row.endsAt);
	return Number.isNaN(endsAt) || endsAt > nowMs;
};

const uriOrUndefined = (value: string | null): ActivityView["linkUri"] => {
	if (!value) return undefined;
	try {
		return asUri(value);
	} catch {
		return undefined;
	}
};

const datetimeOrUndefined = (value: string | null): ActivityView["startedAt"] => {
	if (!value) return undefined;
	try {
		return asDatetime(value);
	} catch {
		return undefined;
	}
};

const proxiedImage = (ctx: AppContext, imageUrl: string | null): string | undefined =>
	imageUrl
		? embedMediaUrl(
				{
					publicUrl: ctx.config.PUBLIC_URL,
					signingKey: ctx.config.SIGNING_KEY,
					nowSeconds: Math.floor(Date.now() / 1000),
				},
				"image",
				imageUrl,
			)
		: undefined;

export const activityView = (ctx: AppContext, row: ActivityRow): ActivityView => ({
	kind: row.kind as ActivityView["kind"],
	title: row.title,
	subtitle: row.subtitle ?? undefined,
	detail: row.detail ?? undefined,
	imageUri: uriOrUndefined(proxiedImage(ctx, row.imageUrl) ?? null),
	linkUri: uriOrUndefined(row.linkUri),
	startedAt: datetimeOrUndefined(row.startedAt),
	endsAt: datetimeOrUndefined(row.endsAt),
	source: row.source,
});

export const loadActivities = async (
	ctx: AppContext,
	dids: readonly string[],
): Promise<Map<string, ActivityView>> => {
	const out = new Map<string, ActivityView>();
	if (dids.length === 0) return out;

	const { db, tables } = ctx.database;
	const rows = await db
		.select({ activity: tables.actorActivity })
		.from(tables.actorActivity)
		.innerJoin(tables.actorSettings, eq(tables.actorSettings.did, tables.actorActivity.did))
		.where(
			and(
				inArray(tables.actorActivity.did, [...dids]),
				eq(tables.actorSettings.shareActivity, true),
			),
		);

	const now = Date.now();
	for (const { activity } of rows) {
		if (!activityIsCurrent(activity, now)) continue;
		out.set(activity.did, activityView(ctx, activity));
	}
	return out;
};

export const loadActivity = async (
	ctx: AppContext,
	did: string,
): Promise<ActivityView | undefined> => (await loadActivities(ctx, [did])).get(did);
