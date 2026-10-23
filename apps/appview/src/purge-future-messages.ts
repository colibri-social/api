import type { Database } from "@colibri-social/appview-db";
import { MESSAGE_FUTURE_SLACK_MS } from "@colibri-social/projections";
import { firstTidAt, tidTime } from "@colibri-social/space";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import type { Logger } from "./logger.js";

export type PurgeOptions = {
	apply: boolean;
	now: Date;
	log: Pick<Logger, "info">;
};

export type FutureMessage = {
	space: string;
	author: string;
	rkey: string;
	createdAt: string;
};

export type ThreadActivity = {
	space: string;
	from: string;
	to: string;
};

export type PurgeReport = {
	applied: boolean;
	messages: FutureMessage[];
	threads: ThreadActivity[];
};

const latestOf = (times: string[]): string =>
	times.reduce((newest, at) => (Date.parse(at) > Date.parse(newest) ? at : newest));

const earlierOf = (first: string, second: string) =>
	Date.parse(first) <= Date.parse(second) ? first : second;

export const purgeFutureMessages = async (
	database: Database,
	options: PurgeOptions,
): Promise<PurgeReport> => {
	const { db, tables } = database;
	const nowIso = options.now.toISOString();
	const cutoff = options.now.getTime() + MESSAGE_FUTURE_SLACK_MS;

	const candidates = await db
		.select({
			space: tables.messages.space,
			author: tables.messages.author,
			rkey: tables.messages.rkey,
			createdAt: tables.messages.createdAt,
		})
		.from(tables.messages)
		.where(gt(tables.messages.rkey, firstTidAt(cutoff)));
	const messages = candidates.filter((row) => {
		const keyTime = tidTime(row.rkey);
		return keyTime !== null && keyTime > cutoff;
	});

	const touchedSpaces = [...new Set(messages.map((row) => row.space))];
	const threadRows = await db
		.select({
			space: tables.threads.space,
			createdAt: tables.threads.createdAt,
			lastActivityAt: tables.threads.lastActivityAt,
		})
		.from(tables.threads)
		.where(
			touchedSpaces.length > 0
				? or(
						inArray(tables.threads.space, touchedSpaces),
						gt(tables.threads.lastActivityAt, nowIso),
					)
				: gt(tables.threads.lastActivityAt, nowIso),
		);

	const purged = new Set(messages.map((row) => `${row.space} ${row.author} ${row.rkey}`));
	const threads: ThreadActivity[] = [];
	for (const thread of threadRows) {
		const remaining = await db
			.select({
				author: tables.messages.author,
				rkey: tables.messages.rkey,
				createdAt: tables.messages.createdAt,
			})
			.from(tables.messages)
			.where(eq(tables.messages.space, thread.space))
			.orderBy(desc(tables.messages.rkey))
			.limit(purged.size + 1);
		const latest = remaining.find(
			(row) => !purged.has(`${thread.space} ${row.author} ${row.rkey}`),
		);
		const to = earlierOf(
			latestOf([thread.createdAt, ...(latest ? [latest.createdAt] : [])]),
			nowIso,
		);
		if (to !== thread.lastActivityAt) {
			threads.push({ space: thread.space, from: thread.lastActivityAt, to });
		}
	}

	for (const row of messages) {
		options.log.info({ ...row, apply: options.apply }, "purge.futureMessage");
	}
	for (const thread of threads) {
		options.log.info({ ...thread, apply: options.apply }, "purge.threadActivity");
	}

	if (options.apply) {
		await db.transaction(async (tx) => {
			for (const row of messages) {
				await tx
					.delete(tables.messages)
					.where(
						and(
							eq(tables.messages.space, row.space),
							eq(tables.messages.author, row.author),
							eq(tables.messages.rkey, row.rkey),
						),
					);
			}
			for (const thread of threads) {
				await tx
					.update(tables.threads)
					.set({ lastActivityAt: thread.to })
					.where(eq(tables.threads.space, thread.space));
			}
		});
	}

	options.log.info(
		{ messages: messages.length, threads: threads.length, apply: options.apply },
		options.apply ? "purge.applied" : "purge.dryRun",
	);
	return { applied: options.apply, messages, threads };
};
