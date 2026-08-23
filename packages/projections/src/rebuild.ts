import { asc, eq } from "drizzle-orm";
import { applyChange, type SpaceChange } from "./apply.js";
import type { ProjectionDeps } from "./context.js";

const PROJECTION_TABLES = [
	"messages",
	"reactions",
	"labels",
	"members",
	"roles",
	"categories",
	"channels",
	"communities",
	"moderationLog",
	"mutes",
	"actorSettings",
	"readCursors",
] as const;

export type RebuildProgress = {
	space: string;
	records: number;
};

export const rebuildProjections = async (
	deps: ProjectionDeps,
	onProgress?: (progress: RebuildProgress) => void,
): Promise<void> => {
	for (const name of PROJECTION_TABLES) {
		await deps.db.delete(deps.tables[name]);
	}

	const spaces = await deps.db
		.select()
		.from(deps.tables.spaces)
		.orderBy(asc(deps.tables.spaces.uri));

	for (const space of spaces) {
		const rows = await deps.db
			.select()
			.from(deps.tables.records)
			.where(eq(deps.tables.records.space, space.uri))
			.orderBy(asc(deps.tables.records.author), asc(deps.tables.records.rkey));

		const byAuthor = new Map<string, SpaceChange>();
		for (const row of rows) {
			const change = byAuthor.get(row.author) ?? {
				space: space.uri,
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
			byAuthor.set(row.author, change);
		}

		for (const change of byAuthor.values()) await applyChange(deps, change);
		onProgress?.({ space: space.uri, records: rows.length });
	}
};
