import { type EmojiRegistry, emojiRegistry } from "@colibri-social/emoji";
import { communitySpaces, type social } from "@colibri-social/lexicons";
import { asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "./context.js";
import {
	type CatalogView,
	ensureEmojiTracked,
	isEmojiTracked,
	loadCatalog,
	parseEmojiUri,
} from "./emoji.js";
import { signBlobUrl } from "./media-token.js";
import { ActorViews } from "./views/actor.js";

export type FollowView = social.colibri.beta.emoji.defs.FollowView;
export type LibraryView = social.colibri.beta.emoji.defs.LibraryView;
type EmojiOwner = social.colibri.beta.emoji.defs.EmojiOwner;
type FollowRow = AppContext["database"]["tables"]["emojiFollows"]["$inferSelect"];

export type FollowKind = "pack" | "emoji";

export const followKindOf = (
	uri: string,
	registry: EmojiRegistry = emojiRegistry,
): FollowKind | undefined => {
	const parsed = parseEmojiUri(uri);
	if (!parsed) return undefined;
	const owned = registry.forCollection(parsed.collection);
	if (owned?.kind === "item") return "emoji";
	if (owned?.kind === "pack") return "pack";
	return undefined;
};

const communityPicture = (
	ctx: AppContext,
	did: string,
	cid: string | null,
	viewer: string,
): string | undefined => {
	if (!cid) return undefined;
	const url = new URL("/xrpc/social.colibri.beta.blob.get", ctx.config.PUBLIC_URL);
	url.searchParams.set("did", did);
	url.searchParams.set("cid", cid);
	url.searchParams.set("space", communitySpaces(did).profile);
	url.searchParams.set("variant", "avatar");
	return signBlobUrl(ctx.config.SIGNING_KEY, url.toString(), viewer, Math.floor(Date.now() / 1000));
};

const loadOwners = async (
	ctx: AppContext,
	dids: readonly string[],
	viewer: string,
): Promise<Map<string, EmojiOwner>> => {
	const out = new Map<string, EmojiOwner>();
	if (dids.length === 0) return out;
	const table = ctx.database.tables.communities;
	const communities = await ctx.database.db
		.select()
		.from(table)
		.where(inArray(table.did, [...dids]));
	for (const row of communities) {
		const avatar = communityPicture(ctx, row.did, row.pictureCid, viewer);
		out.set(row.did, {
			did: row.did,
			kind: "community",
			...(row.handle ? { handle: row.handle } : {}),
			displayName: row.name,
			...(avatar ? { avatar } : {}),
		} as EmojiOwner);
	}
	const users = dids.filter((did) => !out.has(did));
	if (users.length === 0) return out;
	const profiles = await new ActorViews(ctx).hydrate(users).catch(() => new Map());
	for (const did of users) {
		const profile = profiles.get(did);
		out.set(did, {
			did,
			kind: "user",
			...(profile && profile.handle !== "handle.invalid" ? { handle: profile.handle } : {}),
			...(profile?.displayName ? { displayName: profile.displayName } : {}),
			...(profile?.avatar ? { avatar: profile.avatar } : {}),
		} as EmojiOwner);
	}
	return out;
};

const reachable = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry,
): Promise<boolean> => {
	if (await isEmojiTracked(ctx, owner)) return true;
	try {
		await ensureEmojiTracked(ctx, owner, registry);
		return true;
	} catch (error) {
		ctx.log.debug({ err: error, owner }, "emoji.ownerUnreachable");
		return false;
	}
};

const resolveFollow = (
	row: FollowRow,
	kind: FollowKind,
	owner: EmojiOwner,
	catalog: CatalogView | undefined,
): FollowView => {
	const base = {
		uri: `at://${row.follower}/social.colibri.beta.emoji.follow/${row.rkey}`,
		subject: row.subject,
		kind,
		owner,
		createdAt: row.createdAt,
	};
	if (!catalog) return { ...base, state: "unreachable", emojis: [] } as FollowView;
	if (kind === "emoji") {
		const emoji = catalog.emojis.find((entry) => entry.uri === row.subject);
		return (
			emoji
				? { ...base, state: "available", emojis: [emoji] }
				: { ...base, state: "missing", emojis: [] }
		) as FollowView;
	}
	const pack = catalog.packs.find((entry) => entry.uri === row.subject);
	if (!pack) return { ...base, state: "missing", emojis: [] } as FollowView;
	const byUri = new Map(catalog.emojis.map((emoji) => [emoji.uri, emoji]));
	const emojis = pack.emojis.flatMap((uri) => {
		const emoji = byUri.get(uri);
		return emoji ? [emoji] : [];
	});
	return { ...base, state: "available", pack, emojis } as FollowView;
};

export const loadLibrary = async (
	ctx: AppContext,
	did: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<LibraryView> => {
	const table = ctx.database.tables.emojiFollows;
	const [own, rows] = await Promise.all([
		loadCatalog(ctx, did, registry),
		ctx.database.db
			.select()
			.from(table)
			.where(eq(table.follower, did))
			.orderBy(asc(table.createdAt), asc(table.rkey)),
	]);

	const followed = rows.flatMap((row) => {
		const kind = followKindOf(row.subject, registry);
		return kind ? [{ row, kind }] : [];
	});
	const ownerDids = [...new Set(followed.map(({ row }) => row.subjectOwner))];
	const [owners, catalogs] = await Promise.all([
		loadOwners(ctx, ownerDids, did),
		Promise.all(
			ownerDids.map(async (owner) =>
				(await reachable(ctx, owner, registry))
					? ([owner, await loadCatalog(ctx, owner, registry)] as const)
					: ([owner, undefined] as const),
			),
		).then((entries) => new Map(entries)),
	]);

	const follows = followed.map(({ row, kind }) =>
		resolveFollow(
			row,
			kind,
			owners.get(row.subjectOwner) ?? ({ did: row.subjectOwner, kind: "user" } as EmojiOwner),
			catalogs.get(row.subjectOwner),
		),
	);
	return { own, follows } as LibraryView;
};

export const emojiLibraryEvent = (library: LibraryView) => ({
	$type: "social.colibri.beta.sync.defs#emojiLibraryEvent",
	library,
});

export const announceLibrary = async (
	ctx: AppContext,
	did: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<LibraryView> => {
	const library = await loadLibrary(ctx, did, registry);
	ctx.announce.toUser(did, emojiLibraryEvent(library));
	return library;
};

export const followersOf = async (ctx: AppContext, owner: string): Promise<string[]> => {
	const table = ctx.database.tables.emojiFollows;
	const rows = await ctx.database.db
		.selectDistinct({ follower: table.follower })
		.from(table)
		.where(eq(table.subjectOwner, owner));
	return rows.map((row) => row.follower);
};

export const announceToFollowers = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<void> => {
	for (const follower of await followersOf(ctx, owner)) {
		await announceLibrary(ctx, follower, registry).catch((error: unknown) =>
			ctx.log.warn({ err: error, follower, owner }, "emoji.libraryAnnounceFailed"),
		);
	}
};

export const emojiEvent = (catalog: CatalogView) => ({
	$type: "social.colibri.beta.sync.defs#emojiEvent",
	owner: catalog.owner,
	catalog,
});

export const announceEmoji = async (
	ctx: AppContext,
	owner: string,
	audience: "community" | "user",
	registry: EmojiRegistry = emojiRegistry,
): Promise<CatalogView> => {
	const catalog = await loadCatalog(ctx, owner, registry);
	if (audience === "community") ctx.announce.toCommunity(owner, emojiEvent(catalog));
	else await announceLibrary(ctx, owner, registry);
	await announceToFollowers(ctx, owner, registry);
	return catalog;
};
