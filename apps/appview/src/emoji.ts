import { type EmojiRegistry, emojiRegistry } from "@colibri-social/emoji";
import type { social } from "@colibri-social/lexicons";
import { PdsClient } from "@colibri-social/space";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "./context.js";

type EmojiView = social.colibri.beta.emoji.defs.EmojiView;
type PackView = social.colibri.beta.emoji.defs.PackView;
export type CatalogView = social.colibri.beta.emoji.defs.CatalogView;

export type EmojiRecordChange = {
	owner: string;
	collection: string;
	rkey: string;
	cid?: string | null;
	value: Record<string, unknown> | null;
};

const BACKFILL_PAGE = 100;
const BACKFILL_PAGES_MAX = 20;

export const emojiUri = (owner: string, collection: string, rkey: string) =>
	`at://${owner}/${collection}/${rkey}`;

export const parseEmojiUri = (
	uri: string,
): { owner: string; collection: string; rkey: string } | null => {
	if (!uri.startsWith("at://")) return null;
	const [owner, collection, rkey] = uri.slice(5).split("/");
	if (!owner || !collection || !rkey) return null;
	return { owner, collection, rkey };
};

type RecordKey = { owner: string; collection: string; rkey: string };

const itemKey = ({ tables }: AppContext["database"], key: RecordKey) =>
	and(
		eq(tables.emojiItems.owner, key.owner),
		eq(tables.emojiItems.collection, key.collection),
		eq(tables.emojiItems.rkey, key.rkey),
	);

const packKey = ({ tables }: AppContext["database"], key: RecordKey) =>
	and(
		eq(tables.emojiPacks.owner, key.owner),
		eq(tables.emojiPacks.collection, key.collection),
		eq(tables.emojiPacks.rkey, key.rkey),
	);

const membershipKey = ({ tables }: AppContext["database"], key: RecordKey) =>
	and(
		eq(tables.emojiPackItems.owner, key.owner),
		eq(tables.emojiPackItems.collection, key.collection),
		eq(tables.emojiPackItems.rkey, key.rkey),
	);

export const applyEmojiChange = async (
	ctx: AppContext,
	change: EmojiRecordChange,
	registry: EmojiRegistry = emojiRegistry,
): Promise<boolean> => {
	const owned = registry.forCollection(change.collection);
	if (!owned) return false;

	const { db, tables } = ctx.database;
	const uri = emojiUri(change.owner, change.collection, change.rkey);
	const indexedAt = new Date().toISOString();
	const { provider, kind } = owned;

	if (kind === "item") {
		const parsed = change.value ? provider.parseItem(change.value) : null;
		if (!parsed || !change.value) {
			await db.delete(tables.emojiItems).where(itemKey(ctx.database, change));
			return true;
		}
		const row = {
			owner: change.owner,
			collection: change.collection,
			rkey: change.rkey,
			provider: provider.id,
			uri,
			cid: change.cid ?? null,
			name: parsed.name,
			value: change.value,
			indexedAt,
		};
		await db
			.insert(tables.emojiItems)
			.values(row)
			.onConflictDoUpdate({
				target: [tables.emojiItems.owner, tables.emojiItems.collection, tables.emojiItems.rkey],
				set: row,
			});
		return true;
	}

	if (kind === "pack") {
		const parsed = change.value ? provider.parsePack?.(change.value) : null;
		if (!parsed || !change.value) {
			await db.delete(tables.emojiPacks).where(packKey(ctx.database, change));
			return true;
		}
		const row = {
			owner: change.owner,
			collection: change.collection,
			rkey: change.rkey,
			provider: provider.id,
			uri,
			cid: change.cid ?? null,
			value: change.value,
			indexedAt,
		};
		await db
			.insert(tables.emojiPacks)
			.values(row)
			.onConflictDoUpdate({
				target: [tables.emojiPacks.owner, tables.emojiPacks.collection, tables.emojiPacks.rkey],
				set: row,
			});
		return true;
	}

	const parsed = change.value ? provider.parseMembership?.(change.value) : null;
	if (!parsed) {
		await db.delete(tables.emojiPackItems).where(membershipKey(ctx.database, change));
		return true;
	}
	const row = {
		owner: change.owner,
		collection: change.collection,
		rkey: change.rkey,
		provider: provider.id,
		pack: parsed.pack,
		subject: parsed.subject,
		createdAt: parsed.createdAt || indexedAt,
	};
	await db
		.insert(tables.emojiPackItems)
		.values(row)
		.onConflictDoUpdate({
			target: [
				tables.emojiPackItems.owner,
				tables.emojiPackItems.collection,
				tables.emojiPackItems.rkey,
			],
			set: row,
		});
	return true;
};

export const isEmojiTracked = async (ctx: AppContext, owner: string): Promise<boolean> => {
	const [row] = await ctx.database.db
		.select({ owner: ctx.database.tables.emojiBackfills.owner })
		.from(ctx.database.tables.emojiBackfills)
		.where(eq(ctx.database.tables.emojiBackfills.owner, owner))
		.limit(1);
	return row !== undefined;
};

export const backfillEmoji = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry = emojiRegistry,
	client?: PdsClient,
): Promise<void> => {
	const pds = client ?? (await pdsClientFor(ctx, owner));

	for (const collection of registry.collections) {
		let cursor: string | undefined;
		for (let page = 0; page < BACKFILL_PAGES_MAX; page += 1) {
			const result = await pds.listPublicRecords<Record<string, unknown>>(owner, collection, {
				limit: BACKFILL_PAGE,
				...(cursor ? { cursor } : {}),
			});
			for (const record of result.records) {
				const parsed = parseEmojiUri(record.uri);
				if (!parsed) continue;
				await applyEmojiChange(
					ctx,
					{ owner, collection, rkey: parsed.rkey, cid: record.cid, value: record.value },
					registry,
				);
			}
			cursor = result.cursor;
			if (!cursor || result.records.length === 0) break;
		}
	}

	const row = { owner, completedAt: new Date().toISOString() };
	await ctx.database.db
		.insert(ctx.database.tables.emojiBackfills)
		.values(row)
		.onConflictDoUpdate({ target: ctx.database.tables.emojiBackfills.owner, set: row });
};

const pdsClientFor = async (ctx: AppContext, did: string): Promise<PdsClient> => {
	const service = (await ctx.identity.resolveDid(did)).pds;
	if (!service) throw new Error(`${did} has no PDS in its DID document`);
	return new PdsClient({ service });
};

export const ensureEmojiTracked = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<void> => {
	if (await isEmojiTracked(ctx, owner)) return;
	await backfillEmoji(ctx, owner, registry);
};

type ItemRow = {
	uri: string;
	cid: string | null;
	provider: string;
	owner: string;
	value: Record<string, unknown>;
};

const emojiViewOf = (row: ItemRow, registry: EmojiRegistry): EmojiView[] => {
	const parsed = registry.get(row.provider)?.parseItem(row.value);
	if (!parsed) return [];
	return [
		{
			uri: row.uri,
			...(row.cid ? { cid: row.cid } : {}),
			provider: row.provider,
			owner: row.owner,
			...parsed,
		} as EmojiView,
	];
};

export const loadEmojis = async (
	ctx: AppContext,
	owner: string,
	keys: readonly { collection: string; rkey: string }[],
	registry: EmojiRegistry = emojiRegistry,
): Promise<EmojiView[]> => {
	if (keys.length === 0) return [];
	const { db, tables } = ctx.database;
	const rows = await db
		.select()
		.from(tables.emojiItems)
		.where(
			and(
				eq(tables.emojiItems.owner, owner),
				inArray(tables.emojiItems.rkey, [...new Set(keys.map((key) => key.rkey))]),
			),
		);
	const wanted = new Set(keys.map((key) => `${key.collection}/${key.rkey}`));
	return rows
		.filter((row) => wanted.has(`${row.collection}/${row.rkey}`))
		.flatMap((row) => emojiViewOf(row, registry));
};

export const loadCatalog = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<CatalogView> => {
	const { db, tables } = ctx.database;
	const [itemRows, packRows, membershipRows] = await Promise.all([
		db.select().from(tables.emojiItems).where(eq(tables.emojiItems.owner, owner)),
		db.select().from(tables.emojiPacks).where(eq(tables.emojiPacks.owner, owner)),
		db.select().from(tables.emojiPackItems).where(eq(tables.emojiPackItems.owner, owner)),
	]);

	const emojis = itemRows
		.flatMap((row) => emojiViewOf(row, registry))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));

	const known = new Set<string>(emojis.map((emoji) => emoji.uri));
	const memberships = [...membershipRows].sort(
		(a, b) => a.createdAt.localeCompare(b.createdAt) || a.rkey.localeCompare(b.rkey),
	);

	const packs = packRows
		.flatMap((row): PackView[] => {
			const parsed = registry.get(row.provider)?.parsePack?.(row.value);
			if (!parsed) return [];
			const members = [
				...new Set(
					memberships
						.filter((entry) => entry.pack === row.uri && known.has(entry.subject))
						.map((entry) => entry.subject),
				),
			];
			return [
				{
					uri: row.uri,
					provider: row.provider,
					owner: row.owner,
					name: parsed.name,
					...(parsed.description ? { description: parsed.description } : {}),
					emojis: members,
					createdAt: parsed.createdAt,
				} as PackView,
			];
		})
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));

	return { owner, emojis, packs } as CatalogView;
};
