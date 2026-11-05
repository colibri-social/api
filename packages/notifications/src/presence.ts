import { SPACE_TYPES, spaceTypeOf } from "@colibri-social/lexicons";
import { and, eq, gt, gte, inArray } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";

export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const CONNECTION_STALE_MS = 2 * 60 * 1000;

export const connectionStaleBefore = (now: string): string =>
	new Date(Date.parse(now) - CONNECTION_STALE_MS).toISOString();

export const viewersOf = async (
	deps: NotificationDeps,
	dids: readonly string[],
	space: string,
): Promise<Set<string>> => {
	if (dids.length === 0) return new Set();
	const table = deps.tables.presenceConnections;
	const rows = await deps.db
		.select({ did: table.did })
		.from(table)
		.where(
			and(
				inArray(table.did, [...dids]),
				eq(table.viewingChannel, space),
				gte(table.seenAt, connectionStaleBefore(deps.now())),
			),
		);
	return new Set(rows.map((row) => row.did));
};

export const activeAnywhere = async (
	deps: NotificationDeps,
	dids: readonly string[],
): Promise<Set<string>> => {
	if (dids.length === 0) return new Set();
	const now = deps.now();
	const table = deps.tables.presenceConnections;
	const rows = await deps.db
		.select({ did: table.did })
		.from(table)
		.where(
			and(
				inArray(table.did, [...dids]),
				gt(table.activeUntil, now),
				gte(table.seenAt, connectionStaleBefore(now)),
			),
		);
	return new Set(rows.map((row) => row.did));
};

const doNotDisturb = async (
	deps: NotificationDeps,
	dids: readonly string[],
): Promise<Set<string>> => {
	const table = deps.tables.userPresence;
	const rows = await deps.db
		.select({ did: table.did })
		.from(table)
		.where(and(inArray(table.did, [...dids]), eq(table.requestedState, "dnd")));
	return new Set(rows.map((row) => row.did));
};

export const pushSuppressedFor = async (
	deps: NotificationDeps,
	space: string,
	dids: readonly string[],
): Promise<Set<string>> => {
	if (dids.length === 0) return new Set();
	if (spaceTypeOf(space) === SPACE_TYPES.channelVoice) return new Set(dids);
	const [quiet, active] = await Promise.all([doNotDisturb(deps, dids), activeAnywhere(deps, dids)]);
	return new Set([...quiet, ...active]);
};
