import { COLLECTIONS } from "@colibri-social/lexicons";
import { indexMessage } from "@colibri-social/notifications";
import { spaceContextFor } from "@colibri-social/projections";
import type { RepoChange } from "@colibri-social/space-sync";
import type { AppContext } from "./context.js";
import type { EventServer } from "./ws/events.js";

type Deps = {
	ctx: AppContext;
	events: EventServer;
};

const messageFrame = (event: "create" | "update" | "delete", change: RepoChange, rkey: string) => ({
	$type: "social.colibri.sync.defs#messageEvent",
	event,
	channel: change.space,
	subject: { did: change.author, rkey },
});

const reactionFrame = (
	event: "create" | "delete",
	change: RepoChange,
	value: Record<string, unknown>,
	rkey: string,
) => ({
	$type: "social.colibri.sync.defs#reactionEvent",
	event,
	channel: change.space,
	target: value.target ?? { did: change.author, rkey },
	emoji: value.emoji ?? "",
	actor: change.author,
});

export const connectPipeline = ({ ctx, events }: Deps): (() => void) => {
	const unsubscribe = ctx.sync.on("changed", (change) => {
		void handle(change).catch((error) =>
			ctx.log.warn({ space: change.space, author: change.author, error }, "pipeline.failed"),
		);
	});

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
				events.publishToChannel(change.space, messageFrame("create", change, put.rkey));
			}

			if (put.collection === COLLECTIONS.reaction) {
				events.publishToChannel(change.space, reactionFrame("create", change, put.value, put.rkey));
			}

			if (space.community && put.collection === COLLECTIONS.member) {
				events.publishToCommunity(space.community, {
					$type: "social.colibri.sync.defs#memberEvent",
					event: "join",
					community: space.community,
					subject: put.rkey,
				});
			}
		}

		for (const entry of change.deletes) {
			if (entry.collection === COLLECTIONS.message) {
				events.publishToChannel(change.space, messageFrame("delete", change, entry.rkey));
			}
			if (space.community && entry.collection === COLLECTIONS.member) {
				events.publishToCommunity(space.community, {
					$type: "social.colibri.sync.defs#memberEvent",
					event: "leave",
					community: space.community,
					subject: entry.rkey,
				});
			}
		}
	};

	return unsubscribe;
};
