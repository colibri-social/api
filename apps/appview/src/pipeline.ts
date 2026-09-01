import { communitySpaceUris, purgeCommunity } from "@colibri-social/community";
import { COLLECTIONS, LABEL_VALUES, SPACE_TYPES } from "@colibri-social/lexicons";
import {
	createSenders,
	deliverNotification,
	hydrateNotifications,
	type IndexedNotificationRow,
	indexMessage,
} from "@colibri-social/notifications";
import {
	isChannelSpace,
	isPersonalSpace,
	isThreadSpace,
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
	roleEvent,
	threadEvent,
} from "./announce.js";
import type { AppContext } from "./context.js";
import { notificationDeps as buildNotificationDeps } from "./notification-deps.js";
import { loadPreferences } from "./routes/actor.js";
import { reportFailure } from "./sentry.js";
import { ActorViews } from "./views/actor.js";
import { ChannelViews } from "./views/channel.js";
import { CommunityViews } from "./views/community.js";
import { ThreadViews } from "./views/thread.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

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
});

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
			events.publishToCommunity(
				space.community,
				threadEvent("delete", space.community, { space: uri }),
			);
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

	const senders = createSenders(ctx.config.notifications);

	const notifications = buildNotificationDeps(ctx);

	const publishNotifications = async (
		rows: IndexedNotificationRow[],
		text: string,
	): Promise<void> => {
		if (rows.length === 0) return;
		const views = await hydrateNotifications(notifications, rows, (dids) => actors.hydrate(dids));
		const byId = new Map(rows.map((row) => [row.id, row]));
		const servable: IndexedNotificationRow[] = [];
		for (const view of views) {
			const row = byId.get(view.id);
			if (!row) continue;
			events.publishToUser(row.recipient, notificationEvent(view));
			servable.push(row);
		}
		await pushNotifications(servable, text);
	};

	const pushNotifications = async (rows: IndexedNotificationRow[], text: string): Promise<void> => {
		if (rows.length === 0 || ctx.config.pushProviders.length === 0) return;

		const quiet = await doNotDisturb(rows.map((row) => row.recipient));
		await Promise.all(
			rows
				.filter((row) => !quiet.has(row.recipient))
				.map((row) =>
					deliverNotification(notifications, senders, row, { text }).catch((error) =>
						ctx.log.warn({ error }, "push.deliveryFailed"),
					),
				),
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

	const publishMessage = async (space: string, author: string, rkey: string): Promise<void> => {
		const message = await channels.message(space, null, { author, rkey });
		if (!message) return;
		events.publishToChannel(space, (viewer) => ({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: message.updatedAt ? "update" : "create",
			channel: space,
			message: channels.forViewer(message, viewer),
		}));
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

	const handle = async (change: RepoChange): Promise<void> => {
		const space = spaceContextFor(change.space);
		if (!space) return;

		if (isPersonalSpace(space)) {
			events.publishToUser(
				space.authority,
				preferencesEvent(await loadPreferences(ctx, space.authority)),
			);
			return;
		}

		let publishedMessages = 0;

		for (const put of change.puts) {
			if (put.collection === COLLECTIONS.message && space.community) {
				await publishMessage(change.space, change.author, put.rkey);
				publishedMessages += 1;
				if (isThreadSpace(space)) await publishThreadActivity(change.space, space.community);

				const parent = put.value.parent as { did?: string; rkey?: string } | undefined;
				void indexMessage(notifications, {
					space: change.space,
					community: space.community,
					author: change.author,
					rkey: put.rkey,
					facets: (put.value.facets as unknown[] | undefined) ?? null,
					parentAuthor: parent?.did ?? null,
					parentRkey: parent?.rkey ?? null,
				})
					.then((rows) => publishNotifications(rows, String(put.value.text ?? "")))
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
			}
			if (space.community && entry.collection === COLLECTIONS.channel) {
				events.channelChanged(space.community, change.space, "delete");
			}

			if (space.community && entry.collection === COLLECTIONS.thread) {
				events.publishToCommunity(
					space.community,
					threadEvent("delete", space.community, { space: change.space }),
				);
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
	};
};
