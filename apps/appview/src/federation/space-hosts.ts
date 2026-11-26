import type { Database } from "@colibri-social/appview-db";
import type { IdentityResolver } from "@colibri-social/identity";
import { COLLECTIONS, SELF } from "@colibri-social/lexicons";
import { type PdsClient, XrpcError } from "@colibri-social/space";
import { eq } from "drizzle-orm";
import { createSpaceHostResolver, type SpaceHostResolver } from "./resolve-host.js";

export type SpaceHostsDeps = {
	database: Database;
	identity: Pick<IdentityResolver, "resolveDid" | "serviceEndpointFor">;
	clientFor: (endpoint: string) => Pick<PdsClient, "getPublicRecord">;
	self: readonly string[];
};

type StoredHostRecord = { value?: { managingApp?: unknown } };

const APPVIEW_FRAGMENT = "colibri_appview";

export const createSpaceHosts = (deps: SpaceHostsDeps): SpaceHostResolver => {
	const { db, tables } = deps.database;

	return createSpaceHostResolver({
		self: deps.self,
		localManagingApp: async (authority) => {
			const [row] = await db
				.select({ managingApp: tables.communities.managingApp })
				.from(tables.communities)
				.where(eq(tables.communities.did, authority));

			return row ? row.managingApp : undefined;
		},
		load: async (authority) => {
			const [row] = await db
				.select()
				.from(tables.spaceHosts)
				.where(eq(tables.spaceHosts.authority, authority));

			return row ? { ...row, fetchedAt: new Date(row.fetchedAt) } : undefined;
		},
		save: async (entry) => {
			const row = { ...entry, fetchedAt: entry.fetchedAt.toISOString() };

			await db
				.insert(tables.spaceHosts)
				.values(row)
				.onConflictDoUpdate({ target: tables.spaceHosts.authority, set: row });
		},
		publishedManagingApp: async (authority) => {
			const { pds } = await deps.identity.resolveDid(authority);

			if (!pds) return undefined;

			try {
				const stored = await deps
					.clientFor(pds)
					.getPublicRecord<StoredHostRecord>(authority, COLLECTIONS.communityHost, SELF);
				const managingApp = stored.value?.managingApp;

				return typeof managingApp === "string" ? managingApp : undefined;
			} catch (error) {
				if (error instanceof XrpcError && error.code === "RecordNotFound") return undefined;

				throw error;
			}
		},
		endpointFor: (appview) => deps.identity.serviceEndpointFor(appview, APPVIEW_FRAGMENT),
	});
};
