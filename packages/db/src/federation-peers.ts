import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";

export type FederationPeer = {
	did: string;
	blocked: boolean;
	note: string | null;
	updatedAt: string;
};

export type PeerStore = {
	block: (did: string, note?: string) => Promise<void>;
	unblock: (did: string) => Promise<boolean>;
	list: () => Promise<FederationPeer[]>;
	isBlocked: (did: string) => Promise<boolean>;
};

export const createPeerStore = (
	{ primary, db, tables }: Pick<Database, "primary" | "db" | "tables">,
	now: () => Date = () => new Date(),
): PeerStore => {
	const peers = tables.federationPeers;

	return {
		block: async (did, note) => {
			const row = { did, blocked: true, note: note ?? null, updatedAt: now().toISOString() };

			await primary.insert(peers).values(row).onConflictDoUpdate({ target: peers.did, set: row });
		},
		unblock: async (did) => {
			const removed = await primary
				.delete(peers)
				.where(eq(peers.did, did))
				.returning({ did: peers.did });

			return removed.length > 0;
		},
		list: () => {
			return db.select().from(peers).where(eq(peers.blocked, true)).orderBy(asc(peers.did));
		},
		isBlocked: async (did) => {
			const [row] = await db
				.select({ blocked: peers.blocked })
				.from(peers)
				.where(eq(peers.did, did));

			return row?.blocked ?? false;
		},
	};
};
