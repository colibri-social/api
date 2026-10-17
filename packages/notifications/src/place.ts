import { isThreadSpaceType, spaceTypeOf } from "@colibri-social/lexicons";
import { tryParseSpaceRef } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";

export type PushPlace = {
	channel: string;
	thread?: string;
	spaceName?: string;
	channelName?: string;
	threadName?: string;
};

export type PlaceLabels = Pick<PushPlace, "spaceName" | "channelName" | "threadName" | "channel">;

export type KindLabelInput = { kind: string; mentionRole: string | null };

const skeyOf = (space: string): string => tryParseSpaceRef(space)?.skey ?? space;

export const kindLabel = ({ kind, mentionRole }: KindLabelInput): string | undefined => {
	if (kind === "reply") return "Replied to you";
	if (kind !== "mention") return undefined;
	return mentionRole ? `Mentioned @${mentionRole}` : "Mentioned you";
};

export const channelNameOf = (place: PlaceLabels): string =>
	place.channelName ?? skeyOf(place.channel);

export const placeName = (place: PlaceLabels & { thread?: string }): string =>
	place.thread ? (place.threadName ?? channelNameOf(place)) : channelNameOf(place);

export const placeLocation = (place: PlaceLabels & { thread?: string }): string => {
	const channel = `#${channelNameOf(place)}`;
	if (!place.thread) return channel;
	return place.threadName ?? `Thread in ${channel}`;
};

export const notificationSubtitle = (
	notification: KindLabelInput,
	place: PlaceLabels & { thread?: string },
): string => {
	const location = placeLocation(place);
	const where = place.spaceName ? `${place.spaceName} › ${location}` : location;
	const label = kindLabel(notification);
	return label ? `${label} · ${where}` : where;
};

export const resolvePlace = async (deps: NotificationDeps, space: string): Promise<PushPlace> => {
	let channel = space;
	let thread: string | undefined;
	let threadName: string | undefined;
	let community = tryParseSpaceRef(space)?.authority;

	if (isThreadSpaceType(spaceTypeOf(space) ?? "")) {
		const [row] = await deps.db
			.select({
				channel: deps.tables.threads.channel,
				name: deps.tables.threads.name,
				community: deps.tables.threads.community,
			})
			.from(deps.tables.threads)
			.where(eq(deps.tables.threads.space, space))
			.limit(1);
		if (row) {
			channel = row.channel;
			thread = space;
			threadName = row.name || undefined;
			community = row.community;
		}
	}

	const [channelRow] = await deps.db
		.select({ name: deps.tables.channels.name, community: deps.tables.channels.community })
		.from(deps.tables.channels)
		.where(eq(deps.tables.channels.space, channel))
		.limit(1);
	community = channelRow?.community ?? community;

	const [communityRow] = community
		? await deps.db
				.select({ name: deps.tables.communities.name })
				.from(deps.tables.communities)
				.where(eq(deps.tables.communities.did, community))
				.limit(1)
		: [];

	return {
		channel,
		...(thread ? { thread } : {}),
		...(communityRow?.name ? { spaceName: communityRow.name } : {}),
		...(channelRow?.name ? { channelName: channelRow.name } : {}),
		...(threadName ? { threadName } : {}),
	};
};

export type ReadTarget = { channel: string; thread?: string };

export const resolveReadTarget = async (
	deps: NotificationDeps,
	community: string,
	skey: string,
): Promise<ReadTarget | undefined> => {
	const [channelRow] = await deps.db
		.select({ space: deps.tables.channels.space })
		.from(deps.tables.channels)
		.where(and(eq(deps.tables.channels.community, community), eq(deps.tables.channels.skey, skey)))
		.limit(1);
	if (channelRow) return { channel: channelRow.space };

	const [threadRow] = await deps.db
		.select({ space: deps.tables.threads.space, channel: deps.tables.threads.channel })
		.from(deps.tables.threads)
		.where(and(eq(deps.tables.threads.community, community), eq(deps.tables.threads.skey, skey)))
		.limit(1);
	if (threadRow) return { channel: threadRow.channel, thread: threadRow.space };
	return undefined;
};
