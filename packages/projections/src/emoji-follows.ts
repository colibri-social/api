import type { Queryable, Schema } from "@colibri-social/appview-db";
import { and, eq } from "drizzle-orm";

export type EmojiFollowRow = {
	follower: string;
	rkey: string;
	subject: string;
	subjectOwner: string;
	createdAt: string;
};

export const emojiSubjectOwner = (uri: string): string | undefined => {
	if (!uri.startsWith("at://")) return undefined;
	const [owner, collection, rkey, ...rest] = uri.slice("at://".length).split("/");
	return owner?.startsWith("did:") && collection && rkey && rest.length === 0 ? owner : undefined;
};

export const putEmojiFollow = async (
	deps: { db: Queryable; tables: Schema },
	row: EmojiFollowRow,
): Promise<void> => {
	const table = deps.tables.emojiFollows;
	await deps.db
		.delete(table)
		.where(and(eq(table.follower, row.follower), eq(table.rkey, row.rkey)));
	await deps.db
		.insert(table)
		.values(row)
		.onConflictDoUpdate({ target: [table.follower, table.subject], set: row });
};

export const removeEmojiFollow = async (
	deps: { db: Queryable; tables: Schema },
	follower: string,
	rkey: string,
): Promise<void> => {
	const table = deps.tables.emojiFollows;
	await deps.db.delete(table).where(and(eq(table.follower, follower), eq(table.rkey, rkey)));
};
