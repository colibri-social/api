import type { Queryable, Schema } from "@colibri-social/appview-db";
import { and, eq, inArray, sql } from "drizzle-orm";

export type ReadCursor = { channel: string; cursor: string };

const newestPerChannel = (cursors: readonly ReadCursor[]): Map<string, string> => {
	const newest = new Map<string, string>();
	for (const { channel, cursor } of cursors) {
		const current = newest.get(channel);
		if (current === undefined || cursor > current) newest.set(channel, cursor);
	}
	return newest;
};

export const mergeReadCursors = async (
	deps: { db: Queryable; tables: Schema },
	did: string,
	community: string,
	cursors: readonly ReadCursor[],
): Promise<ReadCursor[]> => {
	const newest = newestPerChannel(cursors);
	if (newest.size === 0) return [];

	const table = deps.tables.readCursors;
	const stored = await deps.db
		.select({ channel: table.channel, cursor: table.cursor })
		.from(table)
		.where(and(eq(table.did, did), inArray(table.channel, [...newest.keys()])));
	const held = new Map(stored.map((row) => [row.channel, row.cursor]));

	const moved = [...newest]
		.filter(([channel, cursor]) => {
			const current = held.get(channel);
			return current === undefined || cursor > current;
		})
		.map(([channel, cursor]) => ({ channel, cursor }));
	if (moved.length === 0) return [];

	await deps.db
		.insert(table)
		.values(moved.map((entry) => ({ did, community, ...entry })))
		.onConflictDoUpdate({
			target: [table.did, table.channel],
			set: { community, cursor: sql`excluded.cursor` },
			setWhere: sql`${table.cursor} < excluded.cursor`,
		});
	return moved;
};
