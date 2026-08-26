import type { Database, Queryable } from "@colibri-social/appview-db";
import {
	type CachedIdentity,
	type IdentityStore,
	mapWithConcurrency,
} from "@colibri-social/identity";
import { isChannelSpaceType, toJsonForm } from "@colibri-social/lexicons";
import { applyChange, type ProjectionDeps } from "@colibri-social/projections";
import type { CredentialStorage } from "@colibri-social/space";
import type { RepoChange, RepoCursor, SyncStore } from "@colibri-social/space-sync";
import { and, eq, inArray } from "drizzle-orm";

const IDENTITY_WRITE_CONCURRENCY = 8;

export const drizzleIdentityStore = ({ db, tables }: Database): IdentityStore => ({
	load: async (dids) => {
		const out = new Map<string, CachedIdentity>();
		if (dids.length === 0) return out;
		const rows = await db
			.select()
			.from(tables.identityCache)
			.where(inArray(tables.identityCache.did, [...dids]));
		for (const row of rows) {
			out.set(row.did, {
				did: row.did,
				handle: row.handle,
				handleVerified: row.handleVerified,
				pds: row.pds,
				signingKey: row.signingKey,
				fetchedAt: new Date(row.fetchedAt),
			});
		}
		return out;
	},
	save: async (entries) => {
		if (entries.length === 0) return;
		await mapWithConcurrency(entries, IDENTITY_WRITE_CONCURRENCY, async (entry) => {
			const row = {
				did: entry.did,
				handle: entry.handle,
				handleVerified: entry.handleVerified,
				pds: entry.pds,
				signingKey: entry.signingKey,
				fetchedAt: entry.fetchedAt.toISOString(),
			};
			await db
				.insert(tables.identityCache)
				.values(row)
				.onConflictDoUpdate({ target: tables.identityCache.did, set: row });
		});
	},
});

export const drizzleCredentialStorage = ({ db, tables }: Database): CredentialStorage => ({
	load: async (space) => {
		const [row] = await db
			.select()
			.from(tables.spaceCredentials)
			.where(eq(tables.spaceCredentials.space, space))
			.limit(1);
		if (!row) return null;
		return {
			credential: row.credential,
			privateJwk: row.boundPrivateJwk,
			thumbprint: row.boundKeyThumbprint,
			expiresAt: new Date(row.expiresAt),
		};
	},
	save: async (space, credential) => {
		const row = {
			space,
			credential: credential.credential,
			boundKeyThumbprint: credential.thumbprint,
			boundPrivateJwk: credential.privateJwk,
			expiresAt: credential.expiresAt.toISOString(),
		};
		await db
			.insert(tables.spaceCredentials)
			.values(row)
			.onConflictDoUpdate({ target: tables.spaceCredentials.space, set: row });
	},
	forget: async (space) => {
		await db.delete(tables.spaceCredentials).where(eq(tables.spaceCredentials.space, space));
	},
});

const toCursor = (row: {
	space: string;
	author: string;
	appliedRev: string | null;
	setHashBase64: string | null;
	state: string;
	consecutiveFailures: number;
	retryAfter: string | null;
}): RepoCursor => ({
	space: row.space,
	author: row.author,
	appliedRev: row.appliedRev,
	setHashBase64: row.setHashBase64,
	state: row.state as RepoCursor["state"],
	consecutiveFailures: row.consecutiveFailures,
	retryAfter: row.retryAfter ? new Date(row.retryAfter) : null,
});

export const drizzleSyncStore = (database: Database, projections: ProjectionDeps): SyncStore => {
	const { db, tables } = database;
	const now = () => new Date().toISOString();

	const writeCursor = async (
		tx: Queryable,
		cursor: Pick<RepoCursor, "space" | "author" | "appliedRev" | "setHashBase64" | "state">,
	) => {
		const row = {
			space: cursor.space,
			author: cursor.author,
			appliedRev: cursor.appliedRev,
			setHashBase64: cursor.setHashBase64,
			state: cursor.state,
			error: null,
			consecutiveFailures: 0,
			retryAfter: null,
			syncedAt: now(),
		};
		await tx
			.insert(tables.spaceRepos)
			.values(row)
			.onConflictDoUpdate({
				target: [tables.spaceRepos.space, tables.spaceRepos.author],
				set: row,
			});
	};

	const project = (tx: Queryable, change: RepoChange) =>
		applyChange(
			{ ...projections, db: tx },
			{
				space: change.space,
				author: change.author,
				puts: change.puts.map((put) => ({
					collection: put.collection,
					rkey: put.rkey,
					cid: put.cid,
					value: put.value,
				})),
				deletes: change.deletes,
			},
		);

	return {
		listSpaces: async () => {
			const rows = await db
				.select({ uri: tables.spaces.uri, authority: tables.spaces.authority })
				.from(tables.spaces);
			return rows;
		},

		isOrphaned: async (space) => {
			const [row] = await db
				.select({ community: tables.spaces.community })
				.from(tables.spaces)
				.where(eq(tables.spaces.uri, space))
				.limit(1);
			if (!row?.community) return false;

			const [owner] = await db
				.select({ did: tables.communities.did })
				.from(tables.communities)
				.where(eq(tables.communities.did, row.community))
				.limit(1);
			return !owner;
		},

		listRegistrations: async () => {
			const rows = await db.select().from(tables.notifyRegistrations);
			return rows.map((row) => ({
				space: row.space,
				service: row.service,
				expiresAt: new Date(row.expiresAt),
			}));
		},

		saveRegistration: async ({ space, service, expiresAt }) => {
			const row = { space, service, expiresAt: expiresAt.toISOString() };
			await db
				.insert(tables.notifyRegistrations)
				.values(row)
				.onConflictDoUpdate({ target: tables.notifyRegistrations.space, set: row });
		},

		expectedRepos: async (space) => {
			const [row] = await db
				.select({
					authority: tables.spaces.authority,
					spaceType: tables.spaces.spaceType,
					community: tables.spaces.community,
				})
				.from(tables.spaces)
				.where(eq(tables.spaces.uri, space))
				.limit(1);
			if (!row) return [];
			if (!row.community || !isChannelSpaceType(row.spaceType)) return [row.authority];

			const members = await db
				.select({ did: tables.members.did })
				.from(tables.members)
				.where(eq(tables.members.community, row.community));
			return [row.authority, ...members.map((member) => member.did)];
		},

		listCursors: async (space) => {
			const rows = await db
				.select()
				.from(tables.spaceRepos)
				.where(eq(tables.spaceRepos.space, space));
			return rows.map(toCursor);
		},

		loadCursor: async (space, author) => {
			const [row] = await db
				.select()
				.from(tables.spaceRepos)
				.where(and(eq(tables.spaceRepos.space, space), eq(tables.spaceRepos.author, author)))
				.limit(1);
			return row ? toCursor(row) : null;
		},

		saveCursor: async (cursor) => {
			const row = {
				space: cursor.space,
				author: cursor.author,
				appliedRev: cursor.appliedRev,
				setHashBase64: cursor.setHashBase64,
				state: cursor.state,
				consecutiveFailures: cursor.consecutiveFailures,
				retryAfter: cursor.retryAfter?.toISOString() ?? null,
				syncedAt: now(),
			};
			await db
				.insert(tables.spaceRepos)
				.values(row)
				.onConflictDoUpdate({
					target: [tables.spaceRepos.space, tables.spaceRepos.author],
					set: row,
				});
		},

		commit: async (change, cursor) => {
			await db.transaction(async (tx) => {
				for (const put of change.puts) {
					const row = {
						space: change.space,
						author: change.author,
						collection: put.collection,
						rkey: put.rkey,
						cid: put.cid,
						value: toJsonForm(put.value),
						indexedAt: now(),
					};
					await tx
						.insert(tables.records)
						.values(row)
						.onConflictDoUpdate({
							target: [
								tables.records.space,
								tables.records.author,
								tables.records.collection,
								tables.records.rkey,
							],
							set: row,
						});
				}
				for (const entry of change.deletes) {
					await tx
						.delete(tables.records)
						.where(
							and(
								eq(tables.records.space, change.space),
								eq(tables.records.author, change.author),
								eq(tables.records.collection, entry.collection),
								eq(tables.records.rkey, entry.rkey),
							),
						);
				}
				await project(tx, change);
				await writeCursor(tx, cursor);
			});
		},

		replace: async (change, cursor) => {
			const existing = await db
				.select({ collection: tables.records.collection, rkey: tables.records.rkey })
				.from(tables.records)
				.where(
					and(eq(tables.records.space, change.space), eq(tables.records.author, change.author)),
				);

			await db.transaction(async (tx) => {
				await tx
					.delete(tables.records)
					.where(
						and(eq(tables.records.space, change.space), eq(tables.records.author, change.author)),
					);
				for (const put of change.puts) {
					await tx.insert(tables.records).values({
						space: change.space,
						author: change.author,
						collection: put.collection,
						rkey: put.rkey,
						cid: put.cid,
						value: toJsonForm(put.value),
						indexedAt: now(),
					});
				}
				await project(tx, {
					space: change.space,
					author: change.author,
					puts: [],
					deletes: existing,
				});
				await project(tx, {
					space: change.space,
					author: change.author,
					puts: change.puts,
					deletes: [],
				});
				await writeCursor(tx, cursor);
			});
		},

		dropRepo: async (space, author) => {
			const existing = await db
				.select({ collection: tables.records.collection, rkey: tables.records.rkey })
				.from(tables.records)
				.where(and(eq(tables.records.space, space), eq(tables.records.author, author)));

			await db.transaction(async (tx) => {
				await project(tx, { space, author, puts: [], deletes: existing });
				await tx
					.delete(tables.records)
					.where(and(eq(tables.records.space, space), eq(tables.records.author, author)));
				await tx
					.delete(tables.spaceRepos)
					.where(and(eq(tables.spaceRepos.space, space), eq(tables.spaceRepos.author, author)));
			});
		},

		dropSpace: async (space) => {
			const authors = await db
				.selectDistinct({ author: tables.records.author })
				.from(tables.records)
				.where(eq(tables.records.space, space));

			await db.transaction(async (tx) => {
				for (const { author } of authors) {
					const existing = await tx
						.select({ collection: tables.records.collection, rkey: tables.records.rkey })
						.from(tables.records)
						.where(and(eq(tables.records.space, space), eq(tables.records.author, author)));
					await project(tx, { space, author, puts: [], deletes: existing });
				}
				await tx.delete(tables.records).where(eq(tables.records.space, space));
				await tx.delete(tables.spaceRepos).where(eq(tables.spaceRepos.space, space));
				await tx.delete(tables.spaceCredentials).where(eq(tables.spaceCredentials.space, space));
				await tx
					.delete(tables.notifyRegistrations)
					.where(eq(tables.notifyRegistrations.space, space));
				await tx.delete(tables.spaces).where(eq(tables.spaces.uri, space));
			});
		},
	};
};
