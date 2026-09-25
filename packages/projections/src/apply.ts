import { COLLECTIONS } from "@colibri-social/lexicons";
import { and, eq, inArray, notExists, type SQL, sql } from "drizzle-orm";
import type { ProjectionDeps, RecordRef } from "./context.js";
import { spaceContextFor } from "./context.js";
import * as bridge from "./mappers/bridge.js";
import * as channel from "./mappers/channel.js";
import * as community from "./mappers/community.js";
import * as personal from "./mappers/personal.js";
import * as thread from "./mappers/thread.js";
import { type ErasedProjector, erase, refusalFor } from "./projector.js";

const ALL: ErasedProjector[] = [
	erase(community.communityProfile),
	erase(community.communitySettings),
	erase(community.category),
	erase(community.role),
	erase(community.member),
	erase(community.channel),
	erase(community.moderation),
	erase(channel.message),
	erase(channel.reaction),
	erase(channel.label),
	erase(thread.thread),
	erase(bridge.registration),
	erase(thread.threadFollow),
	erase(personal.mute),
	erase(personal.settings),
	erase(personal.readCursors),
];

const BY_COLLECTION = new Map(ALL.map((projector) => [projector.collection, projector]));

const ADMITTED = ALL.filter((projector) => projector.admission);

const AUTHZ_COLLECTIONS: ReadonlySet<string> = new Set<string>([
	COLLECTIONS.role,
	COLLECTIONS.member,
	COLLECTIONS.channel,
	COLLECTIONS.thread,
	COLLECTIONS.moderation,
	COLLECTIONS.bridgeRegistration,
]);

const announceAuthzChange = (deps: ProjectionDeps, ref: RecordRef): void => {
	const community = ref.space.community;
	if (!community || !AUTHZ_COLLECTIONS.has(ref.collection)) return;
	deps.onAuthzChanged?.({ community, collection: ref.collection });
};

export const projectedCollections = (): string[] => [...BY_COLLECTION.keys()];

export type SpaceChange = {
	space: string;
	author: string;
	puts: Array<{ collection: string; rkey: string; cid: string; value: Record<string, unknown> }>;
	deletes: Array<{ collection: string; rkey: string }>;
};

export const applyChange = async (deps: ProjectionDeps, change: SpaceChange): Promise<void> => {
	const space = spaceContextFor(change.space);
	if (!space) return;

	for (const entry of change.deletes) {
		const projector = BY_COLLECTION.get(entry.collection);
		if (!projector) continue;
		const ref: RecordRef = { space, author: change.author, ...entry, cid: "" };
		const refusal = refusalFor(projector, ref);
		if (refusal) {
			deps.onSkipped?.(ref, refusal);
			continue;
		}
		await projector.remove(deps, ref);
		announceAuthzChange(deps, ref);
	}

	let admission: Promise<string | null> | undefined;
	const admissionRefusal = (projector: ErasedProjector, ref: RecordRef) => {
		if (!projector.admission || !deps.admit) return null;
		admission ??= deps.admit(deps.db, ref);
		return admission;
	};

	for (const entry of change.puts) {
		const projector = BY_COLLECTION.get(entry.collection);
		if (!projector) continue;
		const ref: RecordRef = { space, author: change.author, ...entry };
		const refusal = refusalFor(projector, ref) ?? (await admissionRefusal(projector, ref));
		if (refusal) {
			deps.onSkipped?.(ref, refusal);
			continue;
		}
		const outcome = await projector.apply(deps, ref, entry.value);
		if (!outcome.applied) {
			deps.onSkipped?.(ref, outcome.reason);
			continue;
		}
		announceAuthzChange(deps, ref);
		if (deps.admit) await replayRefused(deps, replayScopeFor(ref, entry.value));
	}
};

type ReplayScope = { space: string } | { community: string; author: string };

const replayScopeFor = (ref: RecordRef, value: Record<string, unknown>): ReplayScope | null => {
	const community = ref.space.community;
	if (!community) return null;
	switch (ref.collection) {
		case COLLECTIONS.member:
			return { community, author: ref.rkey };
		case COLLECTIONS.moderation:
			return value.action === "unban" && typeof value.subject === "string"
				? { community, author: value.subject }
				: null;
		case COLLECTIONS.channel:
		case COLLECTIONS.thread:
			return { space: ref.space.uri };
		default:
			return null;
	}
};

const scopeFilter = (deps: ProjectionDeps, scope: ReplayScope): SQL | undefined => {
	const { records, spaces } = deps.tables;
	if ("space" in scope) return eq(records.space, scope.space);
	return and(
		eq(records.author, scope.author),
		inArray(
			records.space,
			deps.db.select({ uri: spaces.uri }).from(spaces).where(eq(spaces.community, scope.community)),
		),
	);
};

const unprojected = async (
	deps: ProjectionDeps,
	scope: ReplayScope,
	projector: ErasedProjector,
) => {
	if (!projector.admission) return [];
	const { records } = deps.tables;
	const rows = deps.tables[projector.admission.rows];
	return deps.db
		.select()
		.from(records)
		.where(
			and(
				eq(records.collection, projector.collection),
				scopeFilter(deps, scope),
				notExists(
					deps.db
						.select({ found: sql`1` })
						.from(rows)
						.where(
							and(
								eq(rows.space, records.space),
								eq(rows.author, records.author),
								eq(rows.rkey, records.rkey),
							),
						),
				),
			),
		);
};

const replayRefused = async (deps: ProjectionDeps, scope: ReplayScope | null): Promise<void> => {
	if (!scope) return;
	const changes = new Map<string, SpaceChange>();
	for (const projector of ADMITTED) {
		for (const row of await unprojected(deps, scope, projector)) {
			const key = `${row.space} ${row.author}`;
			const change = changes.get(key) ?? {
				space: row.space,
				author: row.author,
				puts: [],
				deletes: [],
			};
			change.puts.push({
				collection: row.collection,
				rkey: row.rkey,
				cid: row.cid,
				value: row.value,
			});
			changes.set(key, change);
		}
	}
	for (const change of changes.values()) await applyChange(deps, change);
};
