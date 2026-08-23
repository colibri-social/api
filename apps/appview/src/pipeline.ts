import { COLLECTIONS, LABEL_VALUES } from "@colibri-social/lexicons";
import { indexMessage } from "@colibri-social/notifications";
import { spaceContextFor } from "@colibri-social/projections";
import type { RepoChange } from "@colibri-social/space-sync";
import type { AppContext } from "./context.js";
import { ActorViews } from "./views/actor.js";
import { ChannelViews } from "./views/channel.js";
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
	const channels = new ChannelViews(ctx, new ActorViews(ctx));

	const unsubscribe = ctx.sync.on("changed", (change) => {
		void handle(change).catch((error) =>
			ctx.log.warn({ space: change.space, author: change.author, error }, "pipeline.failed"),
		);
	});

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

		for (const put of change.puts) {
			if (put.collection === COLLECTIONS.message && space.community) {
				const parent = put.value.parent as { did?: string; rkey?: string } | undefined;
				await indexMessage(
					{
						db: ctx.database.db,
						tables: ctx.database.tables,
						now: () => new Date().toISOString(),
					},
					{
						space: change.space,
						community: space.community,
						author: change.author,
						rkey: put.rkey,
						facets: (put.value.facets as unknown[] | undefined) ?? null,
						parentAuthor: parent?.did ?? null,
						parentRkey: parent?.rkey ?? null,
					},
				).catch((error) => ctx.log.warn({ error }, "notifications.indexFailed"));
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

			if (space.community && put.collection === COLLECTIONS.member) {
				events.publishToCommunity(space.community, {
					$type: "social.colibri.beta.sync.defs#memberEvent",
					event: "join",
					community: space.community,
					subject: put.rkey,
				});
			}
		}

		for (const entry of change.deletes) {
			if (entry.collection === COLLECTIONS.message) {
				events.publishToChannel(change.space, messageDeleted(change, entry.rkey));
			}
			if (space.community && entry.collection === COLLECTIONS.member) {
				events.publishToCommunity(space.community, {
					$type: "social.colibri.beta.sync.defs#memberEvent",
					event: "leave",
					community: space.community,
					subject: entry.rkey,
				});
			}
		}
	};

	return unsubscribe;
};
