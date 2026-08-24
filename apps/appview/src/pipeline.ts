import { COLLECTIONS, LABEL_VALUES } from "@colibri-social/lexicons";
import {
	createSenders,
	deliverNotification,
	hydrateNotifications,
	type IndexedNotificationRow,
	indexMessage,
} from "@colibri-social/notifications";
import { isChannelSpace, isPersonalSpace, spaceContextFor } from "@colibri-social/projections";
import type { RepoChange } from "@colibri-social/space-sync";
import { and, eq, inArray } from "drizzle-orm";
import {
	categoryEvent,
	channelEvent,
	communityEvent,
	memberEvent,
	memberGoneEvent,
	notificationEvent,
	preferencesEvent,
	roleEvent,
} from "./announce.js";
import type { AppContext } from "./context.js";
import { loadPreferences } from "./routes/actor.js";
import { reportFailure } from "./sentry.js";
import { ActorViews } from "./views/actor.js";
import { ChannelViews } from "./views/channel.js";
import { CommunityViews } from "./views/community.js";
import type { EventServer, ServerFrame } from "./ws/events.js";

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

	const unsubscribeDeleted = ctx.sync.on("spaceDeleted", (uri) => {
		const space = spaceContextFor(uri);
		if (!space?.community || !isChannelSpace(space)) return;
		events.publishToCommunity(space.community, channelEvent("delete", space.community, uri));
	});

	const unsubscribe = ctx.sync.on("changed", (change) => {
		void handle(change).catch((error) => {
			reportFailure(error, { stage: "pipeline", space: change.space });
			ctx.log.warn({ space: change.space, author: change.author, error }, "pipeline.failed");
		});
	});

	const senders = createSenders(ctx.config.notifications);

	const notificationDeps = {
		db: ctx.database.db,
		tables: ctx.database.tables,
		now: () => new Date().toISOString(),
	};

	const publishNotifications = async (
		rows: IndexedNotificationRow[],
		text: string,
	): Promise<void> => {
		if (rows.length === 0) return;
		const views = await hydrateNotifications(notificationDeps, rows, (dids) =>
			actors.hydrate(dids),
		);
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
					deliverNotification(notificationDeps, senders, row, { text }).catch((error) =>
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

	const publishMessage = async (space: string, author: string, rkey: string): Promise<void> => {
		const message = await channels.message(space, null, { author, rkey });
		if (!message) return;
		events.publishToChannel(space, {
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: message.updatedAt ? "update" : "create",
			channel: space,
			message,
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

		for (const put of change.puts) {
			if (put.collection === COLLECTIONS.message && space.community) {
				const parent = put.value.parent as { did?: string; rkey?: string } | undefined;
				await indexMessage(notificationDeps, {
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
				await publishMessage(change.space, change.author, put.rkey);
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
				events.publishToCommunity(
					space.community,
					channelEvent("update", space.community, change.space),
				);
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
				events.publishToCommunity(
					space.community,
					channelEvent("delete", space.community, change.space),
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
	};

	return () => {
		unsubscribe();
		unsubscribeDeleted();
	};
};
