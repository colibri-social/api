import type { Database } from "@colibri-social/appview-db";
import type { NotifyWriteHint } from "@colibri-social/space-sync";
import { and, eq, like, sql } from "drizzle-orm";
import type { Logger } from "./logger.js";

const BROKEN_CID = "%[object Object]%";

export type BrokenRepo = { space: string; author: string };

export type ResyncTarget = {
	notifyWrite(space: string, author: string, hint?: NotifyWriteHint): void;
};

export const resyncBrokenCids = async (
	database: Database,
	sync: ResyncTarget,
	log: Pick<Logger, "info">,
): Promise<BrokenRepo[]> => {
	const { db, tables } = database;
	const broken = await db
		.selectDistinct({ space: tables.records.space, author: tables.records.author })
		.from(tables.records)
		.where(like(sql<string>`cast(${tables.records.value} as text)`, BROKEN_CID));

	for (const { space, author } of broken) {
		await db
			.update(tables.spaceRepos)
			.set({
				appliedRev: null,
				setHashBase64: null,
				state: "pending",
				consecutiveFailures: 0,
				retryAfter: null,
			})
			.where(and(eq(tables.spaceRepos.space, space), eq(tables.spaceRepos.author, author)));
		sync.notifyWrite(space, author, { trigger: "sweep" });
	}

	if (broken.length > 0) log.info({ repos: broken.length }, "heal.brokenCidResync");
	return broken;
};
