import { InvalidRequestError, ResponseType, XRPCError } from "@atproto/xrpc-server";
import { sniffMimeType } from "@colibri-social/blobs";
import {
	type BridgeBackfill,
	BridgeError,
	type BridgePairing,
	type BridgeRegistration,
	type BridgeRemoteRoom,
	CommunityCredentialError,
	has,
	Membership,
	Moderation,
	type RegistrationKey,
	type RemoteAuthor,
} from "@colibri-social/community";
import {
	asDatetime,
	asDatetimeOrUndefined,
	asDid,
	asHandleOrUndefined,
	asSpaceRef,
	asTid,
	COLLECTIONS,
	LABEL_VALUES,
	SELF,
	social,
	toJsonForm,
	toLexForm,
} from "@colibri-social/lexicons";
import { labelEvent, messageEvent, messageGone } from "../announce.js";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { anchorOf, ThreadViews } from "../views/thread.js";
import { credentialsUnavailable } from "./failures.js";
import { announceThread, announceThreadDeleted, threadRecord } from "./thread-write.js";
import type { RouteDeps } from "./types.js";

type RegistrationView = social.colibri.beta.bridge.defs.RegistrationView;
type PairingView = social.colibri.beta.bridge.defs.PairingView;
type RemoteRoom = social.colibri.beta.bridge.defs.RemoteRoom;

export const MAX_BRIDGE_BLOB_BYTES = 20 * 1024 * 1024;

const BRIDGE_ERROR_NAMES: Record<BridgeError["failure"], string> = {
	communityNotFound: "CommunityNotFound",
	registrationNotFound: "RegistrationNotFound",
	forbidden: "Forbidden",
	disabled: "RegistrationDisabled",
	channelNotLinked: "ChannelNotLinked",
	channelNotFound: "ChannelNotFound",
	pairingNotFound: "PairingNotFound",
	alreadyRegistered: "AlreadyRegistered",
	recordNotFound: "RecordNotFound",
	notBridged: "NotBridged",
	alreadyReacted: "AlreadyReacted",
	threadNotFound: "ThreadNotFound",
	messageNotFound: "MessageNotFound",
	moderationMirrorOff: "ModerationMirrorOff",
	backfillNotRequested: "BackfillNotRequested",
	outsideBackfillRange: "OutsideBackfillRange",
	rateLimited: "RateLimited",
};

export const bridgeFailureToXrpc = (error: unknown): unknown => {
	if (error instanceof CommunityCredentialError) return credentialsUnavailable(error);
	if (!(error instanceof BridgeError)) return error;
	const name = BRIDGE_ERROR_NAMES[error.failure];
	if (error.failure === "rateLimited") {
		return new XRPCError(ResponseType.RateLimitExceeded, error.message, name);
	}
	return new InvalidRequestError(error.message, name);
};

const translated = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (error) {
		throw bridgeFailureToXrpc(error);
	}
};

const pastOrNow = (value: string | undefined): string => {
	const now = new Date().toISOString();
	return value && value < now ? value : now;
};

const handleOf = async (ctx: AppContext, did: string): Promise<string | undefined> => {
	try {
		return (await ctx.identity.resolveDid(did)).handle ?? undefined;
	} catch {
		return undefined;
	}
};

const backfillView = (row: BridgeBackfill) => ({
	channel: asSpaceRef(row.channel),
	requestedAt: asDatetime(row.requestedAt),
	state: row.state,
	imported: row.imported,
	from: asDatetime(row.from),
	until: asDatetime(row.until),
	reached: asDatetimeOrUndefined(row.reached ?? undefined),
	updatedAt: asDatetime(row.updatedAt),
});

const linkBody = (link: {
	channel: string;
	remoteRoom: string;
	remoteName: string;
	backfill?: { since?: string; requestedAt: string };
}) => ({
	channel: link.channel,
	remoteRoom: link.remoteRoom,
	remoteName: link.remoteName,
	...(link.backfill
		? {
				backfill: {
					...(link.backfill.since ? { since: link.backfill.since } : {}),
					requestedAt: link.backfill.requestedAt,
				},
			}
		: {}),
});

export const registrationView = (
	row: BridgeRegistration,
	bridgeHandle?: string,
	backfills: BridgeBackfill[] = [],
): RegistrationView => ({
	id: asTid(row.id),
	community: asDid(row.community),
	bridge: asDid(row.bridge),
	bridgeHandle: asHandleOrUndefined(bridgeHandle),
	platform: row.platform,
	remoteSpace: row.remoteSpace,
	remoteSpaceName: row.remoteSpaceName,
	links: row.links.map((link) => ({
		channel: asSpaceRef(link.channel),
		remoteRoom: link.remoteRoom,
		remoteName: link.remoteName,
		...(link.backfill
			? {
					backfill: {
						since: asDatetimeOrUndefined(link.backfill.since),
						requestedAt: asDatetime(link.backfill.requestedAt),
					},
				}
			: {}),
	})),
	backfills: backfills.map(backfillView),
	enabled: row.enabled,
	mirrorModeration: row.mirrorModeration,
	createdBy: asDid(row.createdBy),
	createdAt: asDatetime(row.createdAt),
	updatedAt: asDatetimeOrUndefined(row.updatedAt ?? undefined),
});

const pairingView = (row: BridgePairing, bridgeHandle?: string): PairingView => ({
	bridge: asDid(row.bridge),
	bridgeHandle: asHandleOrUndefined(bridgeHandle),
	platform: row.platform,
	remoteSpace: row.remoteSpace,
	remoteSpaceName: row.remoteSpaceName,
	expiresAt: asDatetime(row.expiresAt),
});

const remoteRoomView = (row: BridgeRemoteRoom): RemoteRoom => ({
	id: row.remoteRoom,
	name: row.name,
	...(row.kind ? { kind: row.kind } : {}),
	...(row.parent ? { parent: row.parent } : {}),
});

const views = async (ctx: AppContext, rows: BridgeRegistration[]): Promise<RegistrationView[]> => {
	const handles = new Map<string, string | undefined>();
	for (const bridge of new Set(rows.map((row) => row.bridge))) {
		handles.set(bridge, await handleOf(ctx, bridge));
	}
	const views: RegistrationView[] = [];
	for (const row of rows) {
		views.push(registrationView(row, handles.get(row.bridge), await ctx.bridges.backfills(row)));
	}
	return views;
};

const requireManager = async (ctx: AppContext, community: string, caller: string) => {
	if (!(await ctx.loader.community(community))) {
		throw new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");
	}
	const authz = await ctx.loader.authz(community, caller);
	if (!has(authz, "community.manage")) {
		throw new InvalidRequestError(
			"the requesting user lacks the community.manage permission",
			"Forbidden",
		);
	}
};

const readCappedBlob = async (
	source: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> => {
	const tooLarge = () =>
		new InvalidRequestError("the file is larger than bridges may upload", "BlobTooLarge");
	if (source instanceof Uint8Array) {
		if (source.byteLength > MAX_BRIDGE_BLOB_BYTES) throw tooLarge();
		return source;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of source) {
		total += chunk.byteLength;
		if (total > MAX_BRIDGE_BLOB_BYTES) throw tooLarge();
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

const key = (input: { community: string; registration: string }): RegistrationKey => ({
	community: input.community,
	registration: input.registration,
});

const remoteAuthor = (author: { id: string; name: string; avatar?: unknown }): RemoteAuthor => ({
	id: author.id,
	name: author.name,
	...(author.avatar ? { avatar: toJsonForm(author.avatar) as never } : {}),
});

export const registerBridgeRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);
	const moderation = new Moderation({
		db: ctx.database.db,
		tables: ctx.database.tables,
		loader: ctx.loader,
		writer: ctx.writer,
		membership: new Membership({
			db: ctx.database.db,
			tables: ctx.database.tables,
			loader: ctx.loader,
			writer: ctx.writer,
		}),
	});

	const announceMessage = async (channel: string, author: string, rkey: string) => {
		const message = await channels.message(channel, null, { author, rkey });
		if (!message) return;
		ctx.announce.toChannel(channel, (viewer) =>
			messageEvent(
				message.updatedAt ? "update" : "create",
				channel,
				channels.forViewer(message, viewer),
			),
		);
	};

	const announceReaction = (
		event: "create" | "delete",
		channel: string,
		registration: BridgeRegistration,
		reaction: { target: unknown; emoji: unknown; author: { id: string; name: string } },
	) => {
		ctx.announce.toChannel(channel, {
			$type: "social.colibri.beta.sync.defs#reactionEvent",
			event,
			channel,
			target: reaction.target,
			emoji: reaction.emoji,
			actor: registration.community,
			bridged: {
				registration: registration.id,
				platform: registration.platform,
				remoteId: reaction.author.id,
				name: reaction.author.name,
			},
		});
	};

	const announceToBridge = (
		registration: Pick<BridgeRegistration, "bridge" | "community" | "id">,
		event: "update" | "delete",
	) => {
		ctx.announce.toUser(registration.bridge, {
			$type: "social.colibri.beta.sync.defs#bridgeEvent",
			event,
			community: registration.community,
			registration: registration.id,
		});
	};

	route(server, social.colibri.beta.bridge.createPairing, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const pairing = await translated(() =>
				ctx.bridges.createPairing(caller.credentials.did, input.body),
			);
			return {
				encoding: "application/json" as const,
				body: { code: pairing.code, expiresAt: asDatetime(pairing.expiresAt) },
			};
		},
	});

	route(server, social.colibri.beta.bridge.getPairing, {
		auth: auth.required,
		handler: async ({ params }) => {
			const pairing = await translated(() => ctx.bridges.pairing(params.code));
			return {
				encoding: "application/json" as const,
				body: { pairing: pairingView(pairing, await handleOf(ctx, pairing.bridge)) },
			};
		},
	});

	route(server, social.colibri.beta.bridge.redeemPairing, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await requireManager(ctx, input.body.community, caller.credentials.did);
			const registration = await translated(() =>
				ctx.bridges.redeemPairing(input.body.community, caller.credentials.did, input.body.code),
			);
			announceToBridge(registration, "update");
			return {
				encoding: "application/json" as const,
				body: {
					registration: registrationView(
						registration,
						await handleOf(ctx, registration.bridge),
						await ctx.bridges.backfills(registration),
					),
				},
			};
		},
	});

	route(server, social.colibri.beta.bridge.listRegistrations, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			await requireManager(ctx, params.community, caller.credentials.did);
			const rows = await translated(() => ctx.bridges.listRegistrations(params.community));
			return {
				encoding: "application/json" as const,
				body: { registrations: await views(ctx, rows) },
			};
		},
	});

	route(server, social.colibri.beta.bridge.update, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await requireManager(ctx, input.body.community, caller.credentials.did);
			const registration = await translated(() =>
				ctx.bridges.update(key(input.body), {
					...(input.body.links
						? {
								links: input.body.links.map(linkBody),
							}
						: {}),
					...(input.body.enabled === undefined ? {} : { enabled: input.body.enabled }),
					...(input.body.mirrorModeration === undefined
						? {}
						: { mirrorModeration: input.body.mirrorModeration }),
				}),
			);
			announceToBridge(registration, "update");
			return {
				encoding: "application/json" as const,
				body: {
					registration: registrationView(
						registration,
						await handleOf(ctx, registration.bridge),
						await ctx.bridges.backfills(registration),
					),
				},
			};
		},
	});

	route(server, social.colibri.beta.bridge.revoke, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => {
			await requireManager(ctx, input.body.community, caller.credentials.did);
			const registration = await translated(() => ctx.bridges.registration(key(input.body)));
			await translated(() => ctx.bridges.revoke(key(input.body)));
			announceToBridge(registration, "delete");
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.listRemoteRooms, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			await requireManager(ctx, params.community, caller.credentials.did);
			const rows = await translated(() => ctx.bridges.remoteRooms(key(params)));
			const updatedAt = rows[0]?.updatedAt;
			return {
				encoding: "application/json" as const,
				body: {
					rooms: rows.map(remoteRoomView),
					...(updatedAt ? { updatedAt: asDatetime(updatedAt) } : {}),
				},
			};
		},
	});

	route(server, social.colibri.beta.bridge.getConfiguration, {
		auth: auth.service,
		handler: async ({ auth: caller }) => {
			const rows = await ctx.bridges.registrationsHeldBy(caller.credentials.did);
			return {
				encoding: "application/json" as const,
				body: { registrations: await views(ctx, rows) },
			};
		},
	});

	route(server, social.colibri.beta.bridge.putRemoteRooms, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			await translated(() =>
				ctx.bridges.putRemoteRooms(caller.credentials.did, key(input.body), input.body.rooms),
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.uploadBlob, {
		auth: auth.service,
		handler: async ({ params, input, auth: caller }) => {
			const bytes = await readCappedBlob(input.body as AsyncIterable<Uint8Array> | Uint8Array);
			if (bytes.byteLength === 0) {
				throw new InvalidRequestError("the upload was empty", "InvalidRequest");
			}
			const mimeType = await sniffMimeType(bytes).catch(() => "application/octet-stream");
			const blob = await translated(() =>
				ctx.bridges.uploadBlob(caller.credentials.did, key(params), bytes, mimeType),
			);
			return { encoding: "application/json" as const, body: { blob: toLexForm(blob) as never } };
		},
	});

	route(server, social.colibri.beta.bridge.postMessage, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const { rkey } = await translated(() =>
				ctx.bridges.postMessage(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					author: remoteAuthor(body.author),
					text: body.text,
					...(body.facets ? { facets: [...body.facets] } : {}),
					...(body.parent ? { parent: { did: body.parent.did, rkey: body.parent.rkey } } : {}),
					...(body.attachments ? { attachments: toJsonForm([...body.attachments]) } : {}),
					...(body.forward ? { forward: toJsonForm(body.forward) as Record<string, unknown> } : {}),
					...(body.remoteMessage ? { remoteMessage: body.remoteMessage } : {}),
					...(body.createdAt ? { createdAt: body.createdAt } : {}),
				}),
			);
			await announceMessage(body.channel, body.community, rkey);
			return { encoding: "application/json" as const, body: { rkey } };
		},
	});

	route(server, social.colibri.beta.bridge.importMessages, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const results = await translated(() =>
				ctx.bridges.importMessages(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					messages: body.messages.map((message) => ({
						author: remoteAuthor(message.author),
						text: message.text,
						...(message.facets ? { facets: [...message.facets] } : {}),
						...(message.parent
							? { parent: { did: message.parent.did, rkey: message.parent.rkey } }
							: {}),
						...(message.attachments ? { attachments: toJsonForm([...message.attachments]) } : {}),
						...(message.forward
							? { forward: toJsonForm(message.forward) as Record<string, unknown> }
							: {}),
						remoteMessage: message.remoteMessage,
						createdAt: message.createdAt,
					})),
				}),
			);
			return { encoding: "application/json" as const, body: { results } };
		},
	});

	route(server, social.colibri.beta.bridge.reportBackfill, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			await translated(() =>
				ctx.bridges.reportBackfill(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					requestedAt: body.requestedAt,
					state: body.state === "done" ? "done" : body.state === "failed" ? "failed" : "running",
					imported: body.imported,
					from: body.from,
					until: body.until,
					...(body.reached ? { reached: body.reached } : {}),
				}),
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.editMessage, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			await translated(() =>
				ctx.bridges.editMessage(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					rkey: body.rkey,
					text: body.text,
					...(body.facets ? { facets: [...body.facets] } : {}),
				}),
			);
			await announceMessage(body.channel, body.community, body.rkey);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.deleteMessage, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			await translated(() =>
				ctx.bridges.deleteMessage(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					rkey: body.rkey,
				}),
			);
			ctx.announce.toChannel(
				body.channel,
				messageGone(body.channel, { did: body.community, rkey: body.rkey }),
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.addReaction, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const target = { did: body.target.did, rkey: body.target.rkey };
			const { rkey } = await translated(() =>
				ctx.bridges.addReaction(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					author: remoteAuthor(body.author),
					target,
					emoji: body.emoji,
				}),
			);
			const registration = await translated(() => ctx.bridges.registration(key(body)));
			announceReaction("create", body.channel, registration, {
				target,
				emoji: body.emoji,
				author: body.author,
			});
			return { encoding: "application/json" as const, body: { rkey } };
		},
	});

	route(server, social.colibri.beta.bridge.removeReaction, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const removed = await translated(() =>
				ctx.bridges.removeReaction(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					rkey: body.rkey,
				}),
			);
			const registration = await translated(() => ctx.bridges.registration(key(body)));
			announceReaction("delete", body.channel, registration, removed);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.createThread, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const anchor = body.anchor ? { did: body.anchor.did, rkey: body.anchor.rkey } : undefined;
			const registration = await translated(() =>
				ctx.bridges.threadOpener(caller.credentials.did, key(body), body.channel, anchor),
			);
			const bridged = ctx.bridges.attributionFor(
				registration,
				remoteAuthor(body.author),
				body.remoteThread,
			);
			const space = await translated(() =>
				ctx.bridges.serialize(body.community, async () => {
					const host = await ctx.credentials.connect(body.community);
					const created = await ctx.provisioner.createThreadSpace(host, body.community);
					await ctx.writer.put(body.community, {
						space: created.space,
						collection: COLLECTIONS.thread,
						rkey: SELF,
						record: threadRecord({
							name: body.name,
							channel: body.channel,
							createdBy: body.community,
							createdAt: pastOrNow(body.createdAt),
							anchor: anchor ? { space: body.channel, ...anchor, cid: null } : null,
							visibleToRoles: [],
							visibleToMembers: [],
							bridged,
						}),
					});
					return created.space;
				}),
			);
			const row = await threads.row(space);
			if (row) await announceThread(ctx, threads, row, "create");
			return { encoding: "application/json" as const, body: { thread: asSpaceRef(space) } };
		},
	});

	route(server, social.colibri.beta.bridge.updateThread, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const { record } = await translated(() =>
				ctx.bridges.ownThread(caller.credentials.did, key(body), body.thread),
			);
			const existing = await threads.row(body.thread);
			if (!existing) {
				throw new InvalidRequestError("no thread exists in that space", "ThreadNotFound");
			}
			await translated(() =>
				ctx.bridges.serialize(body.community, () =>
					ctx.writer.put(body.community, {
						space: existing.space,
						collection: COLLECTIONS.thread,
						rkey: SELF,
						record: threadRecord({
							name: body.name,
							channel: existing.channel,
							createdBy: existing.createdBy,
							createdAt: existing.createdAt,
							anchor: anchorOf(existing),
							visibleToRoles: existing.visibleToRoles,
							visibleToMembers: existing.visibleToMembers,
							bridged: record.bridged as Record<string, unknown>,
						}),
					}),
				),
			);
			const row = await threads.row(existing.space);
			if (row) await announceThread(ctx, threads, row, "update");
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.deleteThread, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			await translated(() => ctx.bridges.ownThread(caller.credentials.did, key(body), body.thread));
			const existing = await threads.row(body.thread);
			if (!existing) {
				throw new InvalidRequestError("no thread exists in that space", "ThreadNotFound");
			}
			await translated(() =>
				ctx.bridges.serialize(body.community, async () => {
					const host = await ctx.credentials.connect(body.community);
					await ctx.provisioner.deleteThread(host, existing.space);
				}),
			);
			announceThreadDeleted(ctx, existing);
			return { encoding: "application/json" as const, body: {} };
		},
	});

	route(server, social.colibri.beta.bridge.hideMessage, {
		auth: auth.service,
		handler: async ({ input, auth: caller }) => {
			const body = input.body;
			const subject = {
				did: body.subject.did,
				collection: COLLECTIONS.message,
				rkey: body.subject.rkey,
			};
			await translated(() =>
				ctx.bridges.hideable(caller.credentials.did, {
					...key(body),
					channel: body.channel,
					subject: { did: body.subject.did, rkey: body.subject.rkey },
				}),
			);
			await translated(() =>
				ctx.bridges.serialize(body.community, () =>
					moderation.applyLabel(body.community, body.channel, subject, LABEL_VALUES.hidden, {
						...(body.reason ? { reason: body.reason } : {}),
					}),
				),
			);
			ctx.announce.toChannel(
				body.channel,
				labelEvent("create", body.channel, body.community, subject, LABEL_VALUES.hidden),
			);
			return { encoding: "application/json" as const, body: {} };
		},
	});
};
