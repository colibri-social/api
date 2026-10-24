import { communitySpaceUris, purgeCommunity } from "@colibri-social/community";
import { COLLECTIONS, LABEL_VALUES, SPACE_TYPES } from "@colibri-social/lexicons";
import {
	deliverMessageDeleted,
	deliverMessageEdited,
	deliverNotification,
	hydrateNotifications,
	type IndexedNotificationRow,
	indexMessage,
	type PushAttachment,
	type PushRouting,
	type PushSenderProfile,
} from "@colibri-social/notifications";
import {
	emojiSubjectOwner,
	isChannelSpace,
	isPersonalSpace,
	isThreadSpace,
	messageTimeRefusal,
	spaceContextFor,
} from "@colibri-social/projections";
import type { RepoChange } from "@colibri-social/space-sync";
import { and, eq, inArray } from "drizzle-orm";
import {
	categoryEvent,
	communityEvent,
	memberEvent,
	memberGoneEvent,
	notificationEvent,
	preferencesEvent,
	readCursorEvent,
	roleEvent,
	threadEvent,
	threadFrameForBridges,
} from "./announce.js";
import type { AppContext } from "./context.js";
import { republishWhenPreviewsSettle } from "./embed-republish.js";
import { ensureEmojiTracked } from "./emoji.js";
import { announceLibrary } from "./emoji-library.js";
import { linkUrisOf } from "./link-embeds.js";
import { notificationDeps as buildNotificationDeps } from "./notification-deps.js";
import { pushDelivery } from "./push-delivery.js";
import { loadPreferences } from "./routes/actor.js";
import { reopenThread } from "./routes/thread-write.js";
import { reportFailure } from "./sentry.js";
import { ActorViews, type ProfileView } from "./views/actor.js";
import { ChannelViews, type MessageView } from "./views/channel.js";
import { CommunityViews } from "./views/community.js";
import { ThreadViews } from "./views/thread.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

type ServableNotification = { row: IndexedNotificationRow; routing: PushRouting };

const SLOW_DELIVERY_MS = 2_000;

type Deps = {
	ctx: AppContext;
	events: EventServer;
};

type LabelValue = {
	subject?: { did?: string; collection?: string; rkey?: string };
	val?: string;
	neg?: boolean;
};

const messageDeleted = (change: RepoChange, rkey: string) => ({
	$type: "social.colibri.beta.sync.defs#messageEvent",
	event: "delete",
	channel: change.space,
	subject: { did: change.author, rkey },
});

const reactionFrame = (
	event: "create" | "delete",
	change: RepoChange,
	value: Record<string, unknown>,
	rkey: string,
) => ({
	$type: "social.colibri.beta.sync.defs#reactionEvent",
	event,
	channel: change.space,
	target: value.target ?? { did: change.author, rkey },
	emoji: value.emoji ?? "",
	actor: change.author,
	...customEmojiOf(value),
	...bridgedReactorOf(change, value),
});

const customEmojiOf = (value: Record<string, unknown>) => {
	const ref = value.customEmoji as Record<string, unknown> | undefined;
	if (typeof ref?.uri !== "string") return {};
	return {
		customEmoji: {
			uri: ref.uri,
			...(typeof ref.cid === "string" ? { cid: ref.cid } : {}),
		},
	};
};

const bridgedReactorOf = (change: RepoChange, value: Record<string, unknown>) => {
	const bridged = value.bridged as Record<string, unknown> | undefined;
	if (!bridged || spaceContextFor(change.space)?.authority !== change.author) return {};
	return {
		bridged: {
			registration: bridged.registration,
			platform: bridged.platform,
			remoteId: bridged.remoteId,
			name: bridged.name,
		},
	};
};

const labelFrame = (
	event: "create" | "negate",
	space: string,
	src: string,
	value: LabelValue,
): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#labelEvent",
	event,
	space,
	subject: value.subject,
	val: value.val,
	src,
});

const readCursorsOf = (value: Record<string, unknown>): { channel: string; cursor: string }[] => {
	const cursors = Array.isArray(value.cursors) ? value.cursors : [];
	return cursors.flatMap((entry) => {
		const cursor = entry as { channel?: unknown; cursor?: unknown };
		return typeof cursor.channel === "string" && typeof cursor.cursor === "string"
			? [{ channel: cursor.channel, cursor: cursor.cursor }]
			: [];
	});
};

export const connectPipeline = ({ ctx, events }: Deps): (() => void) => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const communities = new CommunityViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);

	const reconcileDeletedCommunity = async (community: string): Promise<void> => {
		if (!(await ctx.loader.community(community))) return;

		const spaces = await communitySpaceUris(ctx.database, community);
		await purgeCommunity(ctx.database, community, spaces);
		for (const space of spaces) ctx.sync.notifySpaceDeleted(space);

		events.communityDeleted(community);
		ctx.authzChanges.publish({ community, collection: COLLECTIONS.member });
	};

	const unsubscribeDeleted = ctx.sync.on("spaceDeleted", (uri) => {
		const space = spaceContextFor(uri);
		if (!space?.community) return;

		if (isChannelSpace(space)) {
			events.channelChanged(space.community, uri, "delete");
			return;
		}

		if (isThreadSpace(space)) {
			const frame = threadEvent("delete", space.community, { space: uri });
			events.publishToCommunity(space.community, frame);
			void events.publishToBridges(space.community, async () => frame);
			events.threadDeleted(uri);
			return;
		}

		if (space.spaceType !== SPACE_TYPES.communityProfile) return;

		const community = space.community;
		void reconcileDeletedCommunity(community).catch((error) => {
			reportFailure(error, { stage: "pipeline", space: uri });
			ctx.log.warn({ community, error }, "pipeline.communityReconcileFailed");
		});
	});

	const unsubscribe = ctx.sync.on("changed", (change) => {
		void handle(change).catch((error) => {
			reportFailure(error, { stage: "pipeline", space: change.space });
			ctx.log.warn({ space: change.space, author: change.author, error }, "pipeline.failed");
		});
	});

	const push = pushDelivery(ctx);

	const notifications = buildNotificationDeps(ctx);

	const notificationAuthors = actors.notificationAuthors();

	const senderProfile = (profile: ProfileView): PushSenderProfile => ({
		name: profile.displayName || profile.handle,
		...(profile.avatar ? { avatar: profile.avatar } : {}),
	});

	const previewTextOf = (value: Record<string, unknown>): string => {
		const own = String(value.text ?? "");
		if (own.length > 0) return own;
		const forward = value.forward as { text?: unknown } | undefined;
		return String(forward?.text ?? "");
	};

	const pushAttachmentsOf = (
		message: MessageView | undefined,
		recipient: string,
	): PushAttachment[] => {
		if (!message) return [];
		const viewed = channels.forViewer(message, recipient);
		const source =
			viewed.attachments.length > 0 ? viewed.attachments : (viewed.forward?.attachments ?? []);
		return source.map((attachment) => ({
			mimeType: attachment.mimeType,
			url: attachment.url,
			...(attachment.spoiler ? { spoiler: true } : {}),
		}));
	};

	const withFullMessage = <View extends { message?: MessageView }>(
		view: View,
		message: MessageView | undefined,
		recipient: string,
	): View =>
		view.message && message
			? {
					...view,
					message: { ...channels.forViewer(message, recipient), author: view.message.author },
				}
			: view;

	const publishNotifications = async (
		rows: IndexedNotificationRow[],
		text: string,
		message?: MessageView,
	): Promise<void> => {
		if (rows.length === 0) return;
		const views = await hydrateNotifications(notifications, rows, notificationAuthors);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const servable: ServableNotification[] = [];
		for (const view of views) {
			const row = byId.get(view.id);
			if (!row) continue;
			events.publishToUser(
				row.recipient,
				notificationEvent(withFullMessage(view, message, row.recipient)),
			);
			servable.push({
				row,
				routing: {
					channel: view.channel,
					...(view.thread ? { thread: view.thread } : {}),
					sender: senderProfile(view.author),
				},
			});
		}
		await pushNotifications(servable, text, message);
	};

	const outsideVoiceChannel = (target: string, recipient: string): boolean => {
		const space = spaceContextFor(target);
		if (space?.spaceType !== SPACE_TYPES.channelVoice) return false;
		const joined = ctx.voice?.presenceOf(recipient);
		return !joined || spaceContextFor(joined)?.uri !== space.uri;
	};

	const pushNotifications = async (
		servable: ServableNotification[],
		text: string,
		message?: MessageView,
	): Promise<void> => {
		if (servable.length === 0 || !push.enabled) return;

		const quiet = await doNotDisturb(servable.map(({ row }) => row.recipient));
		await Promise.all(
			servable
				.filter(
					({ row }) => !quiet.has(row.recipient) && !outsideVoiceChannel(row.space, row.recipient),
				)
				.map(({ row, routing }) =>
					deliverNotification(
						notifications,
						push.senders,
						row,
						{ text, attachments: pushAttachmentsOf(message, row.recipient) },
						routing,
						push.options,
					).catch((error) => ctx.log.warn({ error }, "push.deliveryFailed")),
				),
		);
	};

	const pushMessageEdited = async (
		space: string,
		author: string,
		rkey: string,
		text: string,
		published?: MessageView,
	): Promise<void> => {
		if (!push.enabled) return;
		const table = ctx.database.tables.messages;
		const [[profile], [message]] = await Promise.all([
			actors.hydrate([author]).then((profiles) => [...profiles.values()]),
			ctx.database.db
				.select({ author: table.author, community: table.community, bridged: table.bridged })
				.from(table)
				.where(and(eq(table.space, space), eq(table.author, author), eq(table.rkey, rkey)))
				.limit(1),
		]);
		await deliverMessageEdited(
			notifications,
			push.senders,
			{ space, author, rkey, text },
			profile
				? (recipient) => {
						const resolved = message
							? actors.resolveMessageAuthor(message, profile, space, recipient)
							: profile;
						return senderProfile(resolved ?? profile);
					}
				: undefined,
			{
				...push.options,
				reaches: (recipient) => !outsideVoiceChannel(space, recipient),
				attachmentsFor: (recipient) => pushAttachmentsOf(published, recipient),
			},
		);
	};

	const pushMessageDeleted = (space: string, author: string, rkey: string): void => {
		if (!push.enabled) return;
		void deliverMessageDeleted(notifications, push.senders, { space, author, rkey }).catch(
			(error) => ctx.log.warn({ error }, "push.deleteFailed"),
		);
	};

	const doNotDisturb = async (dids: string[]): Promise<Set<string>> => {
		const rows = await ctx.database.db
			.select({ did: ctx.database.tables.userPresence.did })
			.from(ctx.database.tables.userPresence)
			.where(
				and(
					inArray(ctx.database.tables.userPresence.did, dids),
					eq(ctx.database.tables.userPresence.requestedState, "dnd"),
				),
			);
		return new Set(rows.map((row) => row.did));
	};

	const publishMember = async (community: string, did: string): Promise<void> => {
		const member = await communities.memberOf(community, did);
		if (!member) return;
		events.publishToCommunity(community, memberEvent("update", community, member));
	};

	const logDelivery = (change: RepoChange, published: number): void => {
		const timing = change.timing;
		if (published === 0 || !timing) return;

		const publishedAt = Date.now();
		const detail = {
			space: change.space,
			author: change.author,
			trigger: timing.trigger,
			messages: published,
			queueMs: timing.notifiedAt === null ? null : timing.startedAt - timing.notifiedAt,
			syncMs: timing.committedAt - timing.startedAt,
			publishMs: publishedAt - timing.committedAt,
			totalMs: timing.notifiedAt === null ? null : publishedAt - timing.notifiedAt,
		};

		if (detail.totalMs !== null && detail.totalMs > SLOW_DELIVERY_MS) {
			ctx.log.warn(detail, "sync.deliverySlow");
			return;
		}
		ctx.log.debug(detail, "sync.delivered");
	};

	const publishMessage = async (
		space: string,
		author: string,
		rkey: string,
		imported = false,
	): Promise<MessageView | undefined> => {
		const key = { author, rkey };
		const message = await channels.message(space, null, key, space, { embedWaitMs: 0 });
		if (!message) return undefined;
		events.publishToChannel(space, (viewer) => ({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: message.updatedAt ? "update" : "create",
			channel: space,
			message: channels.forViewer(message, viewer),
			...(imported ? { imported: true } : {}),
		}));

		republishWhenPreviewsSettle(
			ctx,
			channels,
			(target, frame) => events.publishToChannel(target, frame),
			{ space, readingSpace: space, author, rkey },
			linkUrisOf(message.facets, message.suppressedEmbeds).filter(
				(uri) => !ctx.linkEmbeds.peek(uri),
			),
		);
		return message;
	};

	const publishThread = async (
		space: string,
		community: string,
		event: "create" | "update",
	): Promise<void> => {
		const row = await threads.row(space);
		if (!row) return;
		await events.publishToCommunityViewers(community, async (did) => {
			const authz = await ctx.loader.authz(community, did);
			const view = await threads.view(row, authz, did);
			return view ? threadEvent(event, community, { channel: row.channel, thread: view }) : null;
		});
		await events.publishToBridges(community, threadFrameForBridges(ctx, threads, row, event));
	};

	const reopenOnPost = async (space: string, community: string, postedAt: string) => {
		const row = await threads.row(space);
		if (!row?.closedAt || postedAt <= row.closedAt) return;
		await reopenThread(ctx, row);
		await publishThread(space, community, "update");
	};

	const publishThreadActivity = async (space: string, community: string): Promise<void> => {
		const row = await threads.row(space);
		if (!row) return;
		await events.publishToCommunityViewers(community, async (did) => {
			const authz = await ctx.loader.authz(community, did);
			const view = await threads.view(row, authz, did);
			return view
				? threadEvent("activity", community, {
						channel: row.channel,
						space,
						lastActivityAt: row.lastActivityAt,
						thread: view,
					})
				: null;
		});
	};

	const publishReadCursors = async (did: string, community: string): Promise<void> => {
		const table = ctx.database.tables.readCursors;
		const rows = await ctx.database.db
			.select({ channel: table.channel, cursor: table.cursor })
			.from(table)
			.where(and(eq(table.did, did), eq(table.community, community)));
		if (rows.length > 0) events.publishToUser(did, readCursorEvent(community, rows));
	};

	const publishFollow = async (space: string, community: string, did: string): Promise<void> => {
		const row = await threads.row(space);
		if (!row) return;
		const authz = await ctx.loader.authz(community, did);
		const view = await threads.view(row, authz, did);
		if (view) {
			events.publishToUser(
				did,
				threadEvent("update", community, { channel: row.channel, thread: view }),
			);
		}
	};

	const publishEmojiLibrary = async (did: string, puts: RepoChange["puts"]): Promise<void> => {
		const owners = new Set(
			puts.flatMap((put) => {
				if (put.collection !== COLLECTIONS.emojiFollow) return [];
				const owner = emojiSubjectOwner(String(put.value.subject ?? ""));
				return owner && owner !== did ? [owner] : [];
			}),
		);
		for (const owner of owners) {
			await ensureEmojiTracked(ctx, owner).catch((error: unknown) =>
				ctx.log.debug({ err: error, owner }, "emoji.ownerUnreachable"),
			);
		}
		await announceLibrary(ctx, did).catch((error: unknown) =>
			ctx.log.warn({ err: error, did }, "emoji.libraryAnnounceFailed"),
		);
	};

	const handle = async (change: RepoChange): Promise<void> => {
		const space = spaceContextFor(change.space);
		if (!space) return;

		if (isPersonalSpace(space)) {
			events.publishToUser(
				space.authority,
				preferencesEvent(await loadPreferences(ctx, space.authority)),
			);
			for (const put of change.puts) {
				if (put.collection === COLLECTIONS.channelRead) {
					await publishReadCursors(space.authority, put.rkey);
					push.readMoved(space.authority, put.rkey, readCursorsOf(put.value));
				}
			}
			const follows = [...change.puts, ...change.deletes].filter(
				(entry) => entry.collection === COLLECTIONS.emojiFollow,
			);
			if (follows.length > 0) await publishEmojiLibrary(space.authority, change.puts);
			return;
		}

		if (
			space.community &&
			isThreadSpace(space) &&
			[...change.puts, ...change.deletes].some(
				(entry) => entry.collection === COLLECTIONS.threadFollow,
			)
		) {
			await publishFollow(change.space, space.community, change.author);
		}

		let publishedMessages = 0;

		for (const put of change.puts) {
			if (put.collection === COLLECTIONS.message && space.community) {
				const refusal = messageTimeRefusal(
					ctx.projections,
					{ space, author: change.author, rkey: put.rkey, rev: put.rev },
					{
						createdAt: String(put.value.createdAt ?? ""),
						bridged: put.value.bridged as { imported?: boolean } | undefined,
					},
				);
				if (refusal) continue;
				const imported =
					(put.value.bridged as { imported?: unknown } | undefined)?.imported === true;
				const published = await publishMessage(change.space, change.author, put.rkey, imported);
				publishedMessages += 1;
				if (imported) continue;
				if (isThreadSpace(space)) {
					if (!put.value.updatedAt) {
						await reopenOnPost(change.space, space.community, String(put.value.createdAt ?? ""));
					}
					await publishThreadActivity(change.space, space.community);
				}

				const parent = put.value.parent as { did?: string; rkey?: string } | undefined;
				const community = space.community;
				const text = previewTextOf(put.value);
				const edited = put.value.updatedAt
					? pushMessageEdited(change.space, change.author, put.rkey, text, published).catch(
							(error) => ctx.log.warn({ error }, "push.editFailed"),
						)
					: Promise.resolve();
				void edited
					.then(() =>
						indexMessage(notifications, {
							space: change.space,
							community,
							author: change.author,
							rkey: put.rkey,
							facets: (put.value.facets as unknown[] | undefined) ?? null,
							parentAuthor: parent?.did ?? null,
							parentRkey: parent?.rkey ?? null,
						}),
					)
					.then((rows) => publishNotifications(rows, text, published))
					.catch((error) => ctx.log.warn({ error }, "notifications.indexFailed"));
			}

			if (put.collection === COLLECTIONS.reaction) {
				events.publishToChannel(change.space, reactionFrame("create", change, put.value, put.rkey));
			}

			if (put.collection === COLLECTIONS.label) {
				const value = put.value as LabelValue;
				events.publishToChannel(
					change.space,
					labelFrame(value.neg ? "negate" : "create", change.space, change.author, value),
				);
				if (
					value.neg &&
					value.val === LABEL_VALUES.hidden &&
					value.subject?.collection === COLLECTIONS.message &&
					value.subject.did &&
					value.subject.rkey
				) {
					await publishMessage(change.space, value.subject.did, value.subject.rkey);
				}
			}

			if (space.community && put.collection === COLLECTIONS.channel) {
				events.channelChanged(space.community, change.space, "update");
			}

			if (space.community && put.collection === COLLECTIONS.thread) {
				await publishThread(change.space, space.community, "update");
			}

			if (space.community && put.collection === COLLECTIONS.category) {
				events.publishToCommunity(
					space.community,
					categoryEvent("update", space.community, put.rkey),
				);
			}

			if (space.community && put.collection === COLLECTIONS.community) {
				events.publishToCommunity(space.community, communityEvent("update", space.community));
			}

			if (space.community && put.collection === COLLECTIONS.communitySettings) {
				events.publishToCommunity(space.community, communityEvent("update", space.community));
			}

			if (space.community && put.collection === COLLECTIONS.role) {
				events.publishToCommunity(space.community, roleEvent("update", space.community, put.rkey));
			}

			if (space.community && put.collection === COLLECTIONS.member) {
				await publishMember(space.community, put.rkey);
			}
		}

		for (const entry of change.deletes) {
			if (entry.collection === COLLECTIONS.message) {
				events.publishToChannel(change.space, messageDeleted(change, entry.rkey));
				pushMessageDeleted(change.space, change.author, entry.rkey);
			}
			if (space.community && entry.collection === COLLECTIONS.channel) {
				events.channelChanged(space.community, change.space, "delete");
			}

			if (space.community && entry.collection === COLLECTIONS.thread) {
				const frame = threadEvent("delete", space.community, { space: change.space });
				events.publishToCommunity(space.community, frame);
				void events.publishToBridges(space.community, async () => frame);
			}

			if (space.community && entry.collection === COLLECTIONS.category) {
				events.publishToCommunity(
					space.community,
					categoryEvent("delete", space.community, entry.rkey),
				);
			}

			if (space.community && entry.collection === COLLECTIONS.role) {
				events.publishToCommunity(
					space.community,
					roleEvent("delete", space.community, entry.rkey),
				);
			}

			if (space.community && entry.collection === COLLECTIONS.member) {
				events.publishToCommunity(space.community, memberGoneEvent(space.community, entry.rkey));
			}
		}

		logDelivery(change, publishedMessages);
	};

	return () => {
		unsubscribe();
		unsubscribeDeleted();
		push.close();
	};
};
