import { InvalidRequestError, UpstreamFailureError } from "@atproto/xrpc-server";
import { sniffMimeType } from "@colibri-social/blobs";
import { type CommunityWriter, has } from "@colibri-social/community";
import {
	EMOJI_NAME,
	type EmojiProvider,
	type EmojiRegistry,
	emojiRegistry,
	PACK_NAME_MAX,
	type PackCapableProvider,
	supportsPacks,
} from "@colibri-social/emoji";
import { social } from "@colibri-social/lexicons";
import { putEmojiFollow, removeEmojiFollow } from "@colibri-social/projections";
import { nextTid } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import {
	applyEmojiChange,
	type CatalogView,
	emojiUri,
	ensureEmojiTracked,
	loadCatalog,
	loadEmojis,
	parseEmojiUri,
} from "../emoji.js";
import {
	announceEmoji,
	announceLibrary,
	type FollowView,
	followKindOf,
	type LibraryView,
	loadLibrary,
} from "../emoji-library.js";
import { toXrpcError } from "../errors.js";
import { publicRoute, route } from "../route.js";
import type { RouteDeps } from "./types.js";

const EMOJI_PERMISSION = "community.manage";

type EmojiView = CatalogView["emojis"][number];
type EmojiBatch = social.colibri.beta.emoji.getEmojis.$OutputBody;
type Owner = NonNullable<EmojiBatch["unreachable"]>[number];
type PackView = CatalogView["packs"][number];

const fail = (code: string, message: string) => new InvalidRequestError(message, code);

const requireManager = async (ctx: AppContext, community: string, actor: string) => {
	if (!(await ctx.loader.community(community))) {
		throw fail("CommunityNotFound", "no community exists at that identifier");
	}
	const authz = await ctx.loader.authz(community, actor);
	if (!has(authz, EMOJI_PERMISSION)) {
		throw fail("Forbidden", `you lack the ${EMOJI_PERMISSION} permission`);
	}
};

const requireName = (name: string): string => {
	if (!EMOJI_NAME.test(name)) {
		throw fail("InvalidName", "an emoji name is 2 to 32 lowercase letters, digits or underscores");
	}
	return name;
};

const requirePackName = (name: string): string => {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > PACK_NAME_MAX) {
		throw fail("InvalidName", `a pack name is 1 to ${PACK_NAME_MAX} characters`);
	}
	return trimmed;
};

const requireProvider = (registry: EmojiRegistry, id: string | undefined): EmojiProvider => {
	if (id === undefined) return registry.defaultProvider;
	const provider = registry.get(id);
	if (!provider) throw fail("UnsupportedProvider", `${id} is not a supported emoji provider`);
	return provider;
};

const requirePackProvider = (provider: EmojiProvider): PackCapableProvider => {
	if (!supportsPacks(provider)) {
		throw fail("UnsupportedProvider", `${provider.id} does not support packs`);
	}
	return provider;
};

const loadItem = async (ctx: AppContext, community: string, uri: string) => {
	const parsed = parseEmojiUri(uri);
	if (parsed?.owner !== community)
		throw fail("EmojiNotFound", "no emoji of this community has that URI");
	const { db, tables } = ctx.database;
	const [row] = await db
		.select()
		.from(tables.emojiItems)
		.where(
			and(
				eq(tables.emojiItems.owner, community),
				eq(tables.emojiItems.collection, parsed.collection),
				eq(tables.emojiItems.rkey, parsed.rkey),
			),
		)
		.limit(1);
	if (!row) throw fail("EmojiNotFound", "no emoji of this community has that URI");
	return row;
};

const loadPack = async (ctx: AppContext, community: string, uri: string) => {
	const parsed = parseEmojiUri(uri);
	if (parsed?.owner !== community)
		throw fail("PackNotFound", "no pack of this community has that URI");
	const { db, tables } = ctx.database;
	const [row] = await db
		.select()
		.from(tables.emojiPacks)
		.where(
			and(
				eq(tables.emojiPacks.owner, community),
				eq(tables.emojiPacks.collection, parsed.collection),
				eq(tables.emojiPacks.rkey, parsed.rkey),
			),
		)
		.limit(1);
	if (!row) throw fail("PackNotFound", "no pack of this community has that URI");
	return row;
};

const assertNameFree = async (
	ctx: AppContext,
	community: string,
	name: string,
	except?: string,
) => {
	const { db, tables } = ctx.database;
	const rows = await db
		.select({ uri: tables.emojiItems.uri })
		.from(tables.emojiItems)
		.where(and(eq(tables.emojiItems.owner, community), eq(tables.emojiItems.name, name)));
	if (rows.some((row) => row.uri !== except)) {
		throw fail("NameTaken", `this community already has an emoji named ${name}`);
	}
};

const membershipsOf = (
	ctx: AppContext,
	community: string,
	column: "pack" | "subject",
	uri: string,
) => {
	const { db, tables } = ctx.database;
	return db
		.select()
		.from(tables.emojiPackItems)
		.where(
			and(
				eq(tables.emojiPackItems.owner, community),
				eq(column === "pack" ? tables.emojiPackItems.pack : tables.emojiPackItems.subject, uri),
			),
		);
};

const put = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	write: { collection: string; rkey: string; record: Record<string, unknown> },
	registry: EmojiRegistry,
) => {
	const result = await writer.putPublic(community, write);
	await applyEmojiChange(
		ctx,
		{ owner: community, ...write, cid: result.cid, value: write.record },
		registry,
	);
	return emojiUri(community, write.collection, write.rkey);
};

const remove = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	{ collection, rkey }: { collection: string; rkey: string },
	registry: EmojiRegistry,
) => {
	await writer.removePublic(community, { collection, rkey });
	await applyEmojiChange(ctx, { owner: community, collection, rkey, value: null }, registry);
};

const readImage = async (
	source: AsyncIterable<Uint8Array> | Uint8Array,
	maxBytes: number,
): Promise<Uint8Array> => {
	const tooLarge = () => fail("ImageTooLarge", `an emoji image may not exceed ${maxBytes} bytes`);
	if (source instanceof Uint8Array) {
		if (source.byteLength > maxBytes) throw tooLarge();
		return source;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		total += chunk.byteLength;
		if (total > maxBytes) throw tooLarge();
		chunks.push(chunk);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

const tracked = async (ctx: AppContext, owner: string, registry: EmojiRegistry) => {
	try {
		await ensureEmojiTracked(ctx, owner, registry);
	} catch (error) {
		throw new UpstreamFailureError(
			error instanceof Error ? error.message : "the emoji records could not be read",
			"UpstreamFailure",
		);
	}
};

const emojiIn = (catalog: CatalogView, uri: string): EmojiView => {
	const emoji = catalog.emojis.find((entry) => entry.uri === uri);
	if (!emoji) throw fail("UploadFailed", "the emoji record could not be read back");
	return emoji;
};

const packIn = (catalog: CatalogView, uri: string): PackView => {
	const pack = catalog.packs.find((entry) => entry.uri === uri);
	if (!pack) throw fail("PackNotFound", "the pack record could not be read back");
	return pack;
};

export const handleGetCatalog = async (
	ctx: AppContext,
	owner: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ catalog: CatalogView }> => {
	await tracked(ctx, owner, registry);
	return { catalog: await loadCatalog(ctx, owner, registry) };
};

const BACKFILL_CONCURRENCY = 8;

type EmojiKey = { collection: string; rkey: string };

const keysByOwner = (uris: Iterable<string>, registry: EmojiRegistry) => {
	const byOwner = new Map<string, EmojiKey[]>();
	for (const uri of uris) {
		const parsed = parseEmojiUri(uri);
		if (!parsed?.owner.startsWith("did:")) continue;
		if (registry.forCollection(parsed.collection)?.kind !== "item") continue;
		const keys = byOwner.get(parsed.owner) ?? [];
		keys.push({ collection: parsed.collection, rkey: parsed.rkey });
		byOwner.set(parsed.owner, keys);
	}
	return byOwner;
};

export const handleGetEmojis = async (
	ctx: AppContext,
	uris: readonly string[],
	registry: EmojiRegistry = emojiRegistry,
): Promise<EmojiBatch> => {
	const requested = [...new Set(uris)];
	const owners = [...keysByOwner(requested, registry)];
	const found = new Map<string, EmojiView>();
	const unreachable: Owner[] = [];
	let next = 0;
	const work = async () => {
		while (next < owners.length) {
			const entry = owners[next++];
			if (!entry) return;
			const [owner, keys] = entry;
			try {
				await ensureEmojiTracked(ctx, owner, registry);
			} catch (error) {
				unreachable.push(owner as Owner);
				ctx.log.warn({ code: "UpstreamFailure", owner, error }, "emoji.ownerUnreachable");
				continue;
			}
			for (const emoji of await loadEmojis(ctx, owner, keys, registry)) {
				found.set(emoji.uri, emoji);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, owners.length) }, work));
	const emojis = requested.flatMap((uri) => {
		const emoji = found.get(uri);
		return emoji ? [emoji] : [];
	});
	return unreachable.length > 0 ? { emojis, unreachable: unreachable.sort() } : { emojis };
};

export const handleUploadEmoji = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	params: { community: string; name: string; pack?: string; provider?: string },
	body: AsyncIterable<Uint8Array> | Uint8Array,
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ emoji: EmojiView }> => {
	try {
		const { community } = params;
		await requireManager(ctx, community, actor);
		const name = requireName(params.name);
		const provider = requireProvider(registry, params.provider);
		await tracked(ctx, community, registry);
		await assertNameFree(ctx, community, name);
		const pack = params.pack ? await loadPack(ctx, community, params.pack) : null;
		const packProvider = pack ? requirePackProvider(provider) : null;
		if (pack && pack.provider !== provider.id) {
			throw fail("UnsupportedProvider", "the pack belongs to a different emoji provider");
		}

		const bytes = await readImage(body, provider.maxImageBytes);
		if (bytes.byteLength === 0) throw fail("UnsupportedImage", "the body is empty");
		let mimeType: string;
		try {
			mimeType = await sniffMimeType(bytes);
		} catch {
			throw fail("UnsupportedImage", "the bytes are not a recognised image");
		}
		if (!provider.imageTypes.has(mimeType)) {
			throw fail("UnsupportedImage", `${mimeType} is not an accepted emoji image type`);
		}

		const image = await writer.uploadBlob(community, bytes, mimeType);
		const createdAt = new Date().toISOString();
		const item = provider.buildItem({ name, image, createdAt, newKey: nextTid });
		const uri = await put(ctx, writer, community, item, registry);

		if (pack && packProvider) {
			await put(
				ctx,
				writer,
				community,
				packProvider.buildMembership({ rkey: nextTid(), subject: uri, pack: pack.uri, createdAt }),
				registry,
			);
		}

		const catalog = await announceEmoji(ctx, community, "community", registry);
		return { emoji: emojiIn(catalog, uri) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleRenameEmoji = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	input: { community: string; emoji: string; name: string },
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ emoji: EmojiView }> => {
	try {
		const { community } = input;
		await requireManager(ctx, community, actor);
		const name = requireName(input.name);
		await tracked(ctx, community, registry);
		const row = await loadItem(ctx, community, input.emoji);
		const provider = requireProvider(registry, row.provider);
		await assertNameFree(ctx, community, name, row.uri);

		const renamed = provider.renameItem({ rkey: row.rkey, record: row.value, name });
		const uri = await put(ctx, writer, community, renamed, registry);

		if (uri !== row.uri) {
			const memberships = await membershipsOf(ctx, community, "subject", row.uri);
			if (memberships.length > 0) {
				const packProvider = requirePackProvider(provider);
				for (const membership of memberships) {
					await put(
						ctx,
						writer,
						community,
						packProvider.buildMembership({
							rkey: membership.rkey,
							subject: uri,
							pack: membership.pack,
							createdAt: membership.createdAt,
						}),
						registry,
					);
				}
			}
			await remove(
				ctx,
				writer,
				community,
				{ collection: row.collection, rkey: row.rkey },
				registry,
			);
		}

		const catalog = await announceEmoji(ctx, community, "community", registry);
		return { emoji: emojiIn(catalog, uri) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleDeleteEmoji = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	input: { community: string; emoji: string },
	registry: EmojiRegistry = emojiRegistry,
): Promise<Record<string, never>> => {
	try {
		const { community } = input;
		await requireManager(ctx, community, actor);
		await tracked(ctx, community, registry);
		const row = await loadItem(ctx, community, input.emoji);

		for (const membership of await membershipsOf(ctx, community, "subject", row.uri)) {
			await remove(ctx, writer, community, membership, registry);
		}
		await remove(ctx, writer, community, { collection: row.collection, rkey: row.rkey }, registry);

		await announceEmoji(ctx, community, "community", registry);
		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

const writeMemberships = async (
	ctx: AppContext,
	writer: CommunityWriter,
	community: string,
	provider: PackCapableProvider,
	pack: string,
	emojis: readonly string[],
	registry: EmojiRegistry,
) => {
	const createdAt = new Date().toISOString();
	for (const subject of [...new Set(emojis)]) {
		await put(
			ctx,
			writer,
			community,
			provider.buildMembership({ rkey: nextTid(), subject, pack, createdAt }),
			registry,
		);
	}
};

const requireEmojis = async (ctx: AppContext, community: string, uris: readonly string[]) => {
	for (const uri of uris) await loadItem(ctx, community, uri);
};

export const handleCreatePack = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	input: {
		community: string;
		name: string;
		description?: string;
		emojis: string[];
		provider?: string;
	},
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ pack: PackView }> => {
	try {
		const { community } = input;
		await requireManager(ctx, community, actor);
		const provider = requirePackProvider(requireProvider(registry, input.provider));
		const name = requirePackName(input.name);
		await tracked(ctx, community, registry);
		await requireEmojis(ctx, community, input.emojis);

		const description = input.description?.trim();
		const uri = await put(
			ctx,
			writer,
			community,
			provider.buildPack({
				rkey: nextTid(),
				name,
				...(description ? { description } : {}),
				createdAt: new Date().toISOString(),
			}),
			registry,
		);
		await writeMemberships(ctx, writer, community, provider, uri, input.emojis, registry);

		const catalog = await announceEmoji(ctx, community, "community", registry);
		return { pack: packIn(catalog, uri) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleUpdatePack = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	input: {
		community: string;
		pack: string;
		name?: string;
		description?: string;
		emojis?: string[];
	},
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ pack: PackView }> => {
	try {
		const { community } = input;
		await requireManager(ctx, community, actor);
		await tracked(ctx, community, registry);
		const row = await loadPack(ctx, community, input.pack);
		const provider = requirePackProvider(requireProvider(registry, row.provider));
		const current = provider.parsePack(row.value);
		if (!current) throw fail("PackNotFound", "the pack record is unreadable");

		if (input.name !== undefined || input.description !== undefined) {
			const name = input.name !== undefined ? requirePackName(input.name) : current.name;
			const description =
				input.description !== undefined ? input.description.trim() : current.description;
			const built = provider.buildPack({
				rkey: row.rkey,
				name,
				...(description ? { description } : {}),
				createdAt: current.createdAt,
			});
			const kept = Object.fromEntries(
				Object.entries(row.value).filter(([key]) => key !== "description"),
			);
			await put(
				ctx,
				writer,
				community,
				{ ...built, record: { ...kept, ...built.record } },
				registry,
			);
		}

		if (input.emojis !== undefined) {
			await requireEmojis(ctx, community, input.emojis);
			const existing = (await membershipsOf(ctx, community, "pack", row.uri)).sort(
				(a, b) => a.createdAt.localeCompare(b.createdAt) || a.rkey.localeCompare(b.rkey),
			);
			const next = [...new Set(input.emojis)];
			const unchanged =
				existing.length === next.length &&
				existing.every((membership, index) => membership.subject === next[index]);
			if (!unchanged) {
				for (const membership of existing) {
					await remove(ctx, writer, community, membership, registry);
				}
				await writeMemberships(ctx, writer, community, provider, row.uri, next, registry);
			}
		}

		const catalog = await announceEmoji(ctx, community, "community", registry);
		return { pack: packIn(catalog, row.uri) };
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const handleDeletePack = async (
	ctx: AppContext,
	writer: CommunityWriter,
	actor: string,
	input: { community: string; pack: string },
	registry: EmojiRegistry = emojiRegistry,
): Promise<Record<string, never>> => {
	try {
		const { community } = input;
		await requireManager(ctx, community, actor);
		await tracked(ctx, community, registry);
		const row = await loadPack(ctx, community, input.pack);

		for (const membership of await membershipsOf(ctx, community, "pack", row.uri)) {
			await remove(ctx, writer, community, membership, registry);
		}
		await remove(ctx, writer, community, { collection: row.collection, rkey: row.rkey }, registry);

		await announceEmoji(ctx, community, "community", registry);
		return {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

const subjectExists = async (
	ctx: AppContext,
	kind: "pack" | "emoji",
	key: { owner: string; collection: string; rkey: string },
): Promise<boolean> => {
	const { db, tables } = ctx.database;
	const table = kind === "pack" ? tables.emojiPacks : tables.emojiItems;
	const [row] = await db
		.select({ uri: table.uri })
		.from(table)
		.where(
			and(
				eq(table.owner, key.owner),
				eq(table.collection, key.collection),
				eq(table.rkey, key.rkey),
			),
		)
		.limit(1);
	return row !== undefined;
};

export const handleGetLibrary = async (
	ctx: AppContext,
	actor: string,
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ library: LibraryView }> => ({ library: await loadLibrary(ctx, actor, registry) });

export const handlePutFollow = async (
	ctx: AppContext,
	actor: string,
	input: { rkey: string; subject?: string; createdAt?: string },
	registry: EmojiRegistry = emojiRegistry,
): Promise<{ follow?: FollowView }> => {
	try {
		if (input.subject === undefined) {
			await removeEmojiFollow(ctx.database, actor, input.rkey);
			await announceLibrary(ctx, actor, registry);
			return {};
		}
		const subject = input.subject;
		const parsed = parseEmojiUri(subject);
		const kind = followKindOf(subject, registry);
		if (!parsed || !kind) {
			throw fail(
				"UnsupportedProvider",
				"the subject is not a pack or emoji of a supported provider",
			);
		}
		if (parsed.owner === actor) throw fail("OwnEmoji", "you can't follow your own emoji");
		await tracked(ctx, parsed.owner, registry);
		if (!(await subjectExists(ctx, kind, parsed))) {
			throw kind === "pack"
				? fail("PackNotFound", "no pack exists at that URI")
				: fail("EmojiNotFound", "no emoji exists at that URI");
		}
		await putEmojiFollow(ctx.database, {
			follower: actor,
			rkey: input.rkey,
			subject,
			subjectOwner: parsed.owner,
			createdAt: input.createdAt ?? new Date().toISOString(),
		});
		const library = await announceLibrary(ctx, actor, registry);
		const follow = library.follows.find((entry) => entry.subject === subject);
		return follow ? { follow } : {};
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const registerEmojiRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const json = <T>(body: T) => ({ encoding: "application/json" as const, body });

	publicRoute(server, social.colibri.beta.emoji.getCatalog, {
		handler: async ({ params }) => json(await handleGetCatalog(ctx, params.owner)),
	});

	publicRoute(server, social.colibri.beta.emoji.getEmojis, {
		handler: async ({ params }) => json(await handleGetEmojis(ctx, params.uris)),
	});

	route(server, social.colibri.beta.emoji.getLibrary, {
		auth: auth.required,
		handler: async ({ auth: caller }) => json(await handleGetLibrary(ctx, caller.credentials.did)),
	});

	route(server, social.colibri.beta.emoji.putFollow, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handlePutFollow(ctx, caller.credentials.did, input.body)),
	});

	route(server, social.colibri.beta.emoji.upload, {
		auth: auth.required,
		handler: async ({ params, input, auth: caller }) =>
			json(
				await handleUploadEmoji(
					ctx,
					ctx.writer,
					caller.credentials.did,
					{
						community: params.community,
						name: params.name,
						...(params.pack ? { pack: params.pack } : {}),
						...(params.provider ? { provider: params.provider } : {}),
					},
					input.body as AsyncIterable<Uint8Array> | Uint8Array,
				),
			),
	});

	route(server, social.colibri.beta.emoji.rename, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handleRenameEmoji(ctx, ctx.writer, caller.credentials.did, input.body)),
	});

	route(server, social.colibri.beta.emoji.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handleDeleteEmoji(ctx, ctx.writer, caller.credentials.did, input.body)),
	});

	route(server, social.colibri.beta.emoji.createPack, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handleCreatePack(ctx, ctx.writer, caller.credentials.did, input.body)),
	});

	route(server, social.colibri.beta.emoji.updatePack, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handleUpdatePack(ctx, ctx.writer, caller.credentials.did, input.body)),
	});

	route(server, social.colibri.beta.emoji.deletePack, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) =>
			json(await handleDeletePack(ctx, ctx.writer, caller.credentials.did, input.body)),
	});
};
