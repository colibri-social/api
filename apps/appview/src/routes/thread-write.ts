import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	type ActorAuthz,
	type ChannelState,
	canManageThread,
	canPost,
	canRead,
	canRenameThread,
	has,
	Membership,
	Moderation,
	outranksPosition,
} from "@colibri-social/community";
import {
	CHANNEL_SPACE_TYPES,
	COLLECTIONS,
	isThreadSpaceType,
	LABEL_VALUES,
	SELF,
	social,
	spaceTypeOf,
} from "@colibri-social/lexicons";
import { nextTid, parseSpaceRef } from "@colibri-social/space";
import { and, asc, eq } from "drizzle-orm";
import { labelEvent, messageEvent, messageGone, threadEvent } from "../announce.js";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { anchorOf, type ThreadRow, type ThreadView, ThreadViews } from "../views/thread.js";
import type { RouteDeps } from "./types.js";

const forbidden = (message: string) => new InvalidRequestError(message, "Forbidden");

const invalidRequest = (message: string) => new InvalidRequestError(message, "InvalidRequest");

const threadNotFound = (thread: string) =>
	new InvalidRequestError(`no thread matches ${thread}`, "ThreadNotFound");

const channelNotFound = (channel: string) =>
	new InvalidRequestError(`no channel matches ${channel}`, "ChannelNotFound");

const isTextChannel = (space: string): boolean =>
	(CHANNEL_SPACE_TYPES as readonly string[]).includes(spaceTypeOf(space) ?? "");

const assertVisibilityHierarchy = async (
	ctx: AppContext,
	community: string,
	authz: ActorAuthz,
	visibleToRoles: string[] | undefined,
): Promise<void> => {
	if (!visibleToRoles || visibleToRoles.length === 0) return;
	const roles = await ctx.loader.roles(community);
	const byKey = new Map(roles.map((role) => [role.rkey, role]));
	for (const rkey of visibleToRoles) {
		const role = byKey.get(rkey);
		if (!role) continue;
		if (!outranksPosition(authz, role.position)) {
			throw new InvalidRequestError(
				`you may not grant visibility to the role ${role.name}`,
				"RoleHierarchy",
			);
		}
	}
};

const threadRecord = (
	row: Pick<ThreadRow, "name" | "channel" | "createdBy" | "createdAt"> & {
		anchor: ReturnType<typeof anchorOf>;
		visibleToRoles: string[];
		visibleToMembers: string[];
	},
) => ({
	$type: COLLECTIONS.thread,
	name: row.name,
	channel: row.channel,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	...(row.anchor
		? {
				anchor: {
					space: row.anchor.space,
					did: row.anchor.did,
					rkey: row.anchor.rkey,
					...(row.anchor.cid ? { cid: row.anchor.cid } : {}),
				},
			}
		: {}),
	...(row.visibleToRoles.length ? { visibleToRoles: row.visibleToRoles } : {}),
	...(row.visibleToMembers.length ? { visibleToMembers: row.visibleToMembers } : {}),
});

const messageExists = async (
	ctx: AppContext,
	space: string,
	author: string,
	rkey: string,
): Promise<boolean> => {
	const table = ctx.database.tables.messages;
	const [row] = await ctx.database.db
		.select({ rkey: table.rkey })
		.from(table)
		.where(and(eq(table.space, space), eq(table.author, author), eq(table.rkey, rkey)))
		.limit(1);
	return row !== undefined;
};

export const registerThreadWriteRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);
	const membership = new Membership({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
	});
	const moderation = new Moderation({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
		membership,
	});

	const loadThread = async (space: string): Promise<ThreadRow> => {
		const row = await threads.row(space);
		if (!row) throw threadNotFound(space);
		return row;
	};

	const viewOf = async (row: ThreadRow, viewer: string): Promise<ThreadView> => {
		const authz = await ctx.loader.authz(row.community, viewer);
		const view = await threads.view(row, authz, viewer);
		if (!view) throw forbidden("the requester may not read this thread");
		return view;
	};

	const requireChannel = async (space: string): Promise<ChannelState> => {
		const channel = await ctx.loader.channel(space);
		if (!channel) throw channelNotFound(space);
		return channel;
	};

	route(server, social.colibri.beta.thread.create, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			try {
				const actor = caller.credentials.did;
				const community = input.body.community;
				if (!(await ctx.loader.community(community))) {
					throw new InvalidRequestError(`no community matches ${community}`, "CommunityNotFound");
				}
				if (parseSpaceRef(input.body.channel).authority !== community) {
					throw invalidRequest("that channel belongs to another community");
				}

				const authz = await ctx.loader.authz(community, actor);
				if (!has(authz, "thread.create")) throw forbidden("you lack the thread.create permission");

				const channel = await requireChannel(input.body.channel);
				if (!canPost(authz, channel)) throw forbidden("you may not post in that channel");

				await assertVisibilityHierarchy(ctx, community, authz, input.body.visibleToRoles);

				const anchor = input.body.anchor;
				if (anchor) {
					if (anchor.space !== input.body.channel) {
						throw invalidRequest("the anchor message is not in that channel");
					}
					if (!(await messageExists(ctx, anchor.space, anchor.did, anchor.rkey))) {
						throw new InvalidRequestError(
							`no message ${anchor.rkey} by ${anchor.did} in ${anchor.space}`,
							"MessageNotFound",
						);
					}
				}

				const host = await ctx.credentials.connect(community);
				const { space } = await ctx.provisioner.createThreadSpace(host, community);

				await ctx.writer.put(community, {
					space,
					collection: COLLECTIONS.thread,
					rkey: SELF,
					record: threadRecord({
						name: input.body.name,
						channel: input.body.channel,
						createdBy: actor,
						createdAt: new Date().toISOString(),
						anchor: anchor
							? {
									space: anchor.space,
									did: anchor.did,
									rkey: anchor.rkey,
									cid: anchor.cid ?? null,
								}
							: null,
						visibleToRoles: input.body.visibleToRoles ? [...input.body.visibleToRoles] : [],
						visibleToMembers: input.body.visibleToMembers ? [...input.body.visibleToMembers] : [],
					}),
				});

				const row = await loadThread(space);
				const thread = await viewOf(row, actor);
				await announceThread(ctx, threads, row, "create");

				return { encoding: "application/json" as const, body: { thread } };
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});

	route(server, social.colibri.beta.thread.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			try {
				const actor = caller.credentials.did;
				const existing = await loadThread(input.body.thread);
				const authz = await ctx.loader.authz(existing.community, actor);

				const changesVisibility =
					input.body.visibleToRoles !== undefined || input.body.visibleToMembers !== undefined;
				const permitted = changesVisibility
					? canManageThread(authz)
					: canRenameThread(authz, {
							space: existing.space,
							skey: existing.skey,
							channel: existing.channel,
							createdBy: existing.createdBy,
							visibleToRoles: existing.visibleToRoles,
							visibleToMembers: existing.visibleToMembers,
						});
				if (!permitted) throw forbidden("you may not change this thread");

				await assertVisibilityHierarchy(
					ctx,
					existing.community,
					authz,
					input.body.visibleToRoles ? [...input.body.visibleToRoles] : undefined,
				);

				const visibleToRoles = input.body.visibleToRoles
					? [...input.body.visibleToRoles]
					: existing.visibleToRoles;
				const visibleToMembers = input.body.visibleToMembers
					? [...input.body.visibleToMembers]
					: existing.visibleToMembers;

				await ctx.writer.put(existing.community, {
					space: existing.space,
					collection: COLLECTIONS.thread,
					rkey: SELF,
					record: threadRecord({
						name: input.body.name ?? existing.name,
						channel: existing.channel,
						createdBy: existing.createdBy,
						createdAt: existing.createdAt,
						anchor: anchorOf(existing),
						visibleToRoles,
						visibleToMembers,
					}),
				});

				const row = await loadThread(existing.space);
				const thread = await viewOf(row, actor);
				await announceThread(ctx, threads, row, "update");
				if (changesVisibility) {
					ctx.authzChanges.publish({
						community: existing.community,
						collection: COLLECTIONS.thread,
					});
				}

				return { encoding: "application/json" as const, body: { thread } };
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});

	route(server, social.colibri.beta.thread.repoint, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			try {
				const actor = caller.credentials.did;
				const existing = await loadThread(input.body.thread);
				const authz = await ctx.loader.authz(existing.community, actor);
				const anchor = input.body.anchor;
				const manages = canManageThread(authz);
				if (!manages && !(anchor && existing.anchorAuthor === actor && anchor.did === actor)) {
					throw forbidden("you lack the thread.manage permission");
				}

				if (input.body.channel === existing.channel && !anchor) {
					throw invalidRequest("the thread is already in that channel");
				}
				if (parseSpaceRef(input.body.channel).authority !== existing.community) {
					throw invalidRequest("that channel belongs to another community");
				}
				if (!isTextChannel(input.body.channel)) {
					throw invalidRequest("a thread can only sit beside a text channel");
				}
				const target = await requireChannel(input.body.channel);
				if (!manages && !canPost(authz, target)) {
					throw forbidden("you may not post in that channel");
				}

				if (anchor && anchor.space !== input.body.channel) {
					throw invalidRequest("the anchor message is not in that channel");
				}

				await ctx.writer.put(existing.community, {
					space: existing.space,
					collection: COLLECTIONS.thread,
					rkey: SELF,
					record: threadRecord({
						name: existing.name,
						channel: input.body.channel,
						createdBy: existing.createdBy,
						createdAt: existing.createdAt,
						anchor: anchor
							? { space: anchor.space, did: anchor.did, rkey: anchor.rkey, cid: anchor.cid ?? null }
							: anchorOf(existing),
						visibleToRoles: existing.visibleToRoles,
						visibleToMembers: existing.visibleToMembers,
					}),
				});

				const row = await loadThread(existing.space);
				const thread = await viewOf(row, actor);
				await announceThread(ctx, threads, row, "update");
				ctx.authzChanges.publish({ community: existing.community, collection: COLLECTIONS.thread });

				return { encoding: "application/json" as const, body: { thread } };
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});

	route(server, social.colibri.beta.thread.delete, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			try {
				const existing = await loadThread(input.body.thread);
				const authz = await ctx.loader.authz(existing.community, caller.credentials.did);
				if (!canManageThread(authz)) throw forbidden("you lack the thread.manage permission");

				const host = await ctx.credentials.connect(existing.community);
				await ctx.provisioner.deleteThread(host, existing.space);

				ctx.announce.toCommunity(
					existing.community,
					threadEvent("delete", existing.community, {
						channel: existing.channel,
						space: existing.space,
					}),
				);
				ctx.announce.threadDeleted(existing.space);

				return { encoding: "application/json" as const, body: {} };
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});

	route(server, social.colibri.beta.thread.moveMessages, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			try {
				const actor = caller.credentials.did;
				const source = parseSpaceRef(input.body.source);
				const destination = parseSpaceRef(input.body.destination);

				if (source.authority !== destination.authority) {
					throw invalidRequest("a message can only move within one community");
				}

				const community = source.authority;
				const authz = await ctx.loader.authz(community, actor);
				if (!has(authz, "thread.move")) throw forbidden("you lack the thread.move permission");

				await requireReadable(ctx, source.uri, source.spaceType, authz);
				await requirePostable(ctx, destination.uri, destination.spaceType, authz);

				const subjects = [...input.body.subjects];
				for (const subject of subjects) {
					if (subject.collection !== COLLECTIONS.message) {
						throw invalidRequest("only messages can be moved");
					}
					if (!(await messageExists(ctx, source.uri, subject.did, subject.rkey))) {
						throw new InvalidRequestError(
							`no message ${subject.rkey} by ${subject.did} in ${source.uri}`,
							"MessageNotFound",
						);
					}
				}

				if (source.uri === destination.uri) {
					for (const subject of subjects) {
						const away = await movedDestination(ctx, community, source.uri, subject);
						if (!away) {
							throw invalidRequest("the destination is the space the messages are already in");
						}
						await moderation.negateLabel(
							community,
							source.uri,
							{ did: subject.did, collection: subject.collection, rkey: subject.rkey },
							LABEL_VALUES.moved,
						);
						ctx.announce.toChannel(
							source.uri,
							labelEvent("negate", source.uri, community, subject, LABEL_VALUES.moved),
						);
						ctx.announce.toChannel(away, messageGone(away, subject));

						const back = await channels.message(source.uri, null, {
							author: subject.did,
							rkey: subject.rkey,
						});
						if (back) {
							ctx.announce.toChannel(source.uri, (viewer) =>
								messageEvent("create", source.uri, channels.forViewer(back, viewer)),
							);
						}

						await touchThread(ctx, threads, away, community);
						if (isTextChannel(source.uri)) {
							await carryThread(ctx, threads, source.uri, subject, source.uri);
						}
					}
					return {
						encoding: "application/json" as const,
						body: { batch: nextTid(), count: subjects.length },
					};
				}

				const batch = nextTid();
				for (const subject of subjects) {
					await moderation.applyLabel(
						community,
						source.uri,
						{ did: subject.did, collection: subject.collection, rkey: subject.rkey },
						LABEL_VALUES.moved,
						{
							destination: destination.uri,
							batch,
							...(input.body.reason ? { reason: input.body.reason } : {}),
						},
					);
					ctx.announce.toChannel(
						source.uri,
						labelEvent("create", source.uri, community, subject, LABEL_VALUES.moved),
					);

					const moved = await channels.message(
						source.uri,
						null,
						{ author: subject.did, rkey: subject.rkey },
						destination.uri,
					);
					if (moved) {
						ctx.announce.toChannel(destination.uri, (viewer) =>
							messageEvent("create", destination.uri, channels.forViewer(moved, viewer)),
						);
					}
				}

				await touchThread(ctx, threads, destination.uri, community);

				if (isTextChannel(destination.uri)) {
					for (const subject of subjects) {
						await carryThread(ctx, threads, source.uri, subject, destination.uri);
					}
				}

				return {
					encoding: "application/json" as const,
					body: { batch, count: subjects.length },
				};
			} catch (error) {
				throw toXrpcError(error);
			}
		},
	});
};

const carryThread = async (
	ctx: AppContext,
	threads: ThreadViews,
	source: string,
	subject: { did: string; rkey: string },
	destination: string,
): Promise<void> => {
	const row = await ctx.loader.threadAnchoredAt(source, subject.did, subject.rkey);
	if (!row || row.channel === destination) return;

	await ctx.writer.put(row.community, {
		space: row.space,
		collection: COLLECTIONS.thread,
		rkey: SELF,
		record: threadRecord({
			name: row.name,
			channel: destination,
			createdBy: row.createdBy,
			createdAt: row.createdAt,
			anchor: anchorOf(row),
			visibleToRoles: row.visibleToRoles,
			visibleToMembers: row.visibleToMembers,
		}),
	});

	const moved = await threads.row(row.space);
	if (!moved) return;
	await announceThread(ctx, threads, moved, "update");
	ctx.authzChanges.publish({ community: row.community, collection: COLLECTIONS.thread });
};

const announceThread = async (
	ctx: AppContext,
	threads: ThreadViews,
	row: ThreadRow,
	event: "create" | "update",
): Promise<void> => {
	await ctx.announce.toCommunityViewers(row.community, async (did) => {
		const authz = await ctx.loader.authz(row.community, did);
		const view = await threads.view(row, authz, did);
		return view ? threadEvent(event, row.community, { channel: row.channel, thread: view }) : null;
	});
};

const requireReadable = async (
	ctx: AppContext,
	space: string,
	spaceType: string,
	authz: ActorAuthz,
): Promise<void> => {
	const states = await ctx.loader.spaceStates(space, spaceType);
	if (!states.channel) throw new InvalidRequestError(`no space at ${space}`, "SpaceNotFound");
	if (!canRead(authz, states.channel)) throw forbidden("you may not read that space");
};

const requirePostable = async (
	ctx: AppContext,
	space: string,
	spaceType: string,
	authz: ActorAuthz,
): Promise<void> => {
	const states = await ctx.loader.spaceStates(space, spaceType);
	if (!states.channel) throw new InvalidRequestError(`no space at ${space}`, "SpaceNotFound");
	if (!canPost(authz, states.channel)) throw forbidden("you may not post in that space");
};

const movedDestination = async (
	ctx: AppContext,
	community: string,
	space: string,
	subject: { did: string; rkey: string },
): Promise<string | undefined> => {
	const table = ctx.database.tables.labels;
	const rows = await ctx.database.db
		.select()
		.from(table)
		.where(
			and(
				eq(table.space, space),
				eq(table.src, community),
				eq(table.subjectDid, subject.did),
				eq(table.subjectRkey, subject.rkey),
				eq(table.val, LABEL_VALUES.moved),
			),
		)
		.orderBy(asc(table.rkey));
	const latest = rows.at(-1);
	if (!latest || latest.negated || !latest.destination) return undefined;
	return latest.destination;
};

const touchThread = async (
	ctx: AppContext,
	threads: ThreadViews,
	space: string,
	community: string,
): Promise<void> => {
	if (!isThreadSpaceType(spaceTypeOf(space) ?? "")) return;
	const table = ctx.database.tables.threads;
	const lastActivityAt = new Date().toISOString();
	await ctx.database.db.update(table).set({ lastActivityAt }).where(eq(table.space, space));

	const row = await threads.row(space);
	await ctx.announce.toCommunityViewers(community, async (did) => {
		const authz = await ctx.loader.authz(community, did);
		const view = row ? await threads.view(row, authz, did) : null;
		return threadEvent("activity", community, {
			space,
			lastActivityAt,
			...(row ? { channel: row.channel } : {}),
			...(view ? { thread: view } : {}),
		});
	});
};
