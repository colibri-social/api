import type { AuthzChange } from "@colibri-social/projections";
import {
	type EventMessage,
	messageEvent,
	type ThreadRecipe,
	threadEvent,
	threadFrameForBridges,
} from "./announce.js";
import { type BusDelivery, REPLAY_WAIT_MS } from "./bus.js";
import type { ClusterOrder } from "./cluster/orders.js";
import type { AppContext } from "./context.js";
import { ActorViews } from "./views/actor.js";
import { ChannelViews } from "./views/channel.js";
import { ThreadViews } from "./views/thread.js";
import type { VoiceCommand } from "./voice-calls.js";
import type { EventServer } from "./ws/events.js";

export type DeliveryDeps = {
	ctx: AppContext;
	events: EventServer;
	authz: (change: AuthzChange) => void;
	voice?: (command: VoiceCommand) => Promise<void>;
	cluster?: (order: ClusterOrder) => Promise<void>;
};

const readsDatabase = (message: EventMessage): boolean => {
	return message.t === "thread" || message.t === "communityPermission";
};

export const eventDelivery = ({ ctx, events, authz, voice, cluster }: DeliveryDeps) => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);

	const renderThread = async ({
		community,
		space,
		event,
		lastActivityAt,
		whenHidden,
		bridges,
	}: ThreadRecipe): Promise<void> => {
		const row = await threads.row(space);

		if (!row && whenHidden === "skip") {
			return;
		}

		await events.publishToCommunityViewers(community, async (did) => {
			const view = row
				? await threads.view(row, await ctx.loader.authz(community, did), did)
				: null;

			if (!view && whenHidden === "skip") {
				return null;
			}

			if (event === "activity") {
				return threadEvent("activity", community, {
					space,
					...(row ? { channel: row.channel } : {}),
					...(view ? { thread: view } : {}),
					...((lastActivityAt ?? row?.lastActivityAt)
						? { lastActivityAt: lastActivityAt ?? row?.lastActivityAt ?? undefined }
						: {}),
				});
			}

			return view && row
				? threadEvent(event, community, { channel: row.channel, thread: view })
				: null;
		});

		if (bridges && row && event !== "activity") {
			await events.publishToBridges(community, threadFrameForBridges(ctx, threads, row, event));
		}
	};

	const deliver = async (message: EventMessage): Promise<void> => {
		switch (message.t) {
			case "topics":
				events.publishTo(message.topics, message.frame);

				return;
			case "community":
				events.publishToCommunity(message.community, message.frame);

				return;
			case "communityPermission":
				await events.publishToCommunityPermission(
					message.community,
					message.permission,
					message.frame,
				);

				return;
			case "channel":
				events.publishToChannel(message.space, message.frame, message.except);

				return;
			case "message":
				events.publishToChannel(message.space, (viewer) => ({
					...messageEvent(
						message.event,
						message.space,
						channels.forViewer(message.message, viewer),
					),
					...(message.imported ? { imported: true } : {}),
				}));

				return;
			case "thread":
				await renderThread(message.recipe);

				return;
			case "user":
				events.publishToUser(message.did, message.frame);

				return;
			case "bridges":
				await events.publishToBridges(message.community, async () => message.frame);

				return;
			case "channelChanged":
				events.channelChanged(message.community, message.space, message.event);

				return;
			case "threadDeleted":
				events.threadDeleted(message.space);

				return;
			case "communityDeleted":
				events.communityDeleted(message.community);

				return;
			case "authz":
				authz(message.change);

				return;
			case "voiceCommand":
				if (message.node === ctx.nodeId && voice) {
					await voice(message.command);
				}

				return;
			case "clusterOrder":
				await cluster?.(message.order);

				return;
			case "clusterOrderResult":
				return;
		}
	};

	return async ({ message, lsn, local }: BusDelivery<EventMessage>): Promise<void> => {
		if (!local && lsn && readsDatabase(message)) {
			const caughtUp = await ctx.database.waitForReplay(lsn, REPLAY_WAIT_MS);

			if (!caughtUp) {
				ctx.log.warn({ lsn, kind: message.t }, "bus.replicaBehind");
			}
		}

		await deliver(message);
	};
};
