import type { Queryable, Schema } from "@colibri-social/appview-db";
import { communitySpaces } from "@colibri-social/lexicons";
import { eq, inArray } from "drizzle-orm";

export type PurgeDeps = {
	db: Queryable;
	tables: Schema;
};

export const communitySpaceUris = async (deps: PurgeDeps, community: string): Promise<string[]> => {
	const { db, tables } = deps;

	const registered = await db
		.select({ uri: tables.spaces.uri })
		.from(tables.spaces)
		.where(eq(tables.spaces.community, community));

	const projected = await db
		.select({ uri: tables.channels.space })
		.from(tables.channels)
		.where(eq(tables.channels.community, community));

	const threads = await db
		.select({ uri: tables.threads.space })
		.from(tables.threads)
		.where(eq(tables.threads.community, community));

	const uris = new Set<string>(Object.values(communitySpaces(community)));
	for (const { uri } of registered) uris.add(uri);
	for (const { uri } of projected) uris.add(uri);
	for (const { uri } of threads) uris.add(uri);

	return [...uris].sort();
};

export const purgeCommunity = async (
	deps: PurgeDeps,
	community: string,
	spaces: readonly string[],
): Promise<void> => {
	const { db, tables } = deps;

	await db.transaction(async (tx) => {
		const byCommunity = [
			{ table: tables.messages, column: tables.messages.community },
			{ table: tables.moderationLog, column: tables.moderationLog.community },
			{ table: tables.notifications, column: tables.notifications.community },
			{ table: tables.readCursors, column: tables.readCursors.community },
			{ table: tables.invitations, column: tables.invitations.community },
			{ table: tables.applications, column: tables.applications.community },
			{ table: tables.categories, column: tables.categories.community },
			{ table: tables.channels, column: tables.channels.community },
			{ table: tables.threads, column: tables.threads.community },
			{ table: tables.roles, column: tables.roles.community },
			{ table: tables.members, column: tables.members.community },
			{ table: tables.communities, column: tables.communities.did },
		];

		for (const { table, column } of byCommunity) {
			await tx.delete(table).where(eq(column, community));
		}

		if (spaces.length === 0) return;

		const bySpace = [
			{ table: tables.reactions, column: tables.reactions.space },
			{ table: tables.threadFollows, column: tables.threadFollows.space },
			{ table: tables.labels, column: tables.labels.space },
			{ table: tables.records, column: tables.records.space },
			{ table: tables.spaceRepos, column: tables.spaceRepos.space },
			{ table: tables.spaceCredentials, column: tables.spaceCredentials.space },
			{ table: tables.notifyRegistrations, column: tables.notifyRegistrations.space },
			{ table: tables.spaces, column: tables.spaces.uri },
		];

		for (const { table, column } of bySpace) {
			await tx.delete(table).where(inArray(column, [...spaces]));
		}
	});
};
