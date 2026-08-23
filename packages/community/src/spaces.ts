import type { Database } from "@colibri-social/appview-db";
import { parseSpaceRef } from "@colibri-social/space";
import { eq } from "drizzle-orm";

export type SpaceRegistration = {
	uri: string;
	community: string | null;
	host: string;
};

export type SpaceRegistry = {
	register(space: SpaceRegistration): Promise<void>;
	forget(uri: string): Promise<void>;
};

export type SpaceRegistryDeps = {
	database: Database;
	onRegistered?: (uri: string) => void;
	now?: () => Date;
};

export const spaceRegistry = ({
	database,
	onRegistered,
	now,
}: SpaceRegistryDeps): SpaceRegistry => {
	const { db, tables } = database;
	const clock = now ?? (() => new Date());

	return {
		register: async ({ uri, community, host }) => {
			const { authority, spaceType, skey } = parseSpaceRef(uri);
			const row = {
				uri,
				authority,
				spaceType,
				skey,
				community,
				host,
				createdAt: clock().toISOString(),
			};

			await db
				.insert(tables.spaces)
				.values(row)
				.onConflictDoUpdate({
					target: tables.spaces.uri,
					set: { spaceType: row.spaceType, skey: row.skey, community, host },
				});

			onRegistered?.(uri);
		},

		forget: async (uri) => {
			await db.delete(tables.spaces).where(eq(tables.spaces.uri, uri));
		},
	};
};
