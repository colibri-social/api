import { CommunityCredentialError, ensureHostRecord } from "@colibri-social/community";
import { XrpcError } from "@colibri-social/space";
import { eq, isNull, or } from "drizzle-orm";
import type { AppContext } from "../context.js";

const failureCode = (error: unknown): string => {
	if (error instanceof CommunityCredentialError) return error.failure;
	if (error instanceof XrpcError) return error.code;

	return "Unknown";
};

export const backfillHostRecords = async (ctx: AppContext): Promise<void> => {
	const { communities } = ctx.database.tables;
	const appview = ctx.config.APPVIEW_DID;
	const rows = await ctx.database.db
		.select({ did: communities.did })
		.from(communities)
		.where(or(eq(communities.managingApp, appview), isNull(communities.managingApp)));

	let written = 0;

	for (const { did } of rows) {
		if (!(await ctx.credentials.has(did))) continue;

		try {
			const host = await ctx.credentials.connect(did);

			if (await ensureHostRecord(host, appview)) written += 1;
		} catch (error) {
			ctx.log.warn({ community: did, code: failureCode(error) }, "federation.hostRecordFailed");
		}
	}

	if (written > 0) {
		ctx.log.info({ written, code: "HostRecordsWritten" }, "federation.hostRecords");
	}
};
