import { InvalidRequestError } from "@atproto/xrpc-server";
import { canReadThread } from "@colibri-social/community";
import { asDid, social } from "@colibri-social/lexicons";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { type ThreadRow, ThreadViews, toThreadState } from "../views/thread.js";
import type { RouteDeps } from "./types.js";

const threadNotFound = (thread: string) =>
	new InvalidRequestError(`no thread matches ${thread}`, "ThreadNotFound");

const forbidden = (message: string) => new InvalidRequestError(message, "Forbidden");

const pageCursor = (row: ThreadRow): string => `${row.lastActivityAt} ${row.space}`;

const followedSpaces = async (ctx: AppContext, did: string): Promise<string[]> => {
	const table = ctx.database.tables.threadFollows;
	const rows = await ctx.database.db
		.select({ space: table.space })
		.from(table)
		.where(eq(table.did, did));
	return rows.map((row) => row.space);
};

type ListThreadsParams = {
	community: string;
	channel?: string;
	filter?: string;
	limit: number;
	cursor?: string;
};

export const handleGetThread = async (
	ctx: AppContext,
	threads: ThreadViews,
	thread: string,
	viewer: string,
) => {
	const row = await threads.row(thread);
	if (!row) throw threadNotFound(thread);

	const authz = await ctx.loader.authz(row.community, viewer);
	const own = await threads.view(row, authz, viewer, { anchorMessages: true });
	const view =
		own ??
		(await threads.view(row, authz, viewer, {
			anchorMessages: true,
			granted: await threads.bridgeReadable([row], viewer),
		}));

	if (!view) throw forbidden("the requester may not read this thread");

	return { thread: view };
};

export const handleListThreads = async (
	ctx: AppContext,
	threads: ThreadViews,
	params: ListThreadsParams,
	viewer: string,
) => {
	const community = await ctx.loader.community(params.community);
	if (!community) {
		throw new InvalidRequestError(`no community matches ${params.community}`, "CommunityNotFound");
	}

	const authz = await ctx.loader.authz(params.community, viewer);
	const bridged =
		!authz.member &&
		!authz.isOwner &&
		params.channel !== undefined &&
		(await ctx.bridges.mayRead(viewer, params.channel));

	if (!authz.member && !authz.isOwner && !bridged) {
		throw forbidden("the requester is not a member of this community");
	}

	if (params.channel) {
		const channel = await ctx.loader.channel(params.channel);
		if (!channel) {
			throw new InvalidRequestError(`no channel matches ${params.channel}`, "ChannelNotFound");
		}
	}

	const table = ctx.database.tables.threads;
	const filters = [eq(table.community, params.community)];
	if (params.channel) filters.push(eq(table.channel, params.channel));
	if (params.cursor) filters.push(lt(table.lastActivityAt, params.cursor.split(" ")[0] ?? ""));
	if (params.filter === "following") {
		const followed = await followedSpaces(ctx, viewer);
		if (followed.length === 0) return { threads: [] };
		filters.push(inArray(table.space, followed));
	}

	const rows = await ctx.database.db
		.select()
		.from(table)
		.where(and(...filters))
		.orderBy(desc(table.lastActivityAt))
		.limit(params.limit + 1);

	const page = rows.slice(0, params.limit);
	const cursor = rows.length > params.limit ? page.at(-1) : undefined;
	const granted = bridged ? await threads.bridgeReadable(page, viewer) : undefined;
	const views = await threads.views(page, authz, viewer, { granted });

	return {
		threads: params.filter === "unread" ? views.filter((v) => v.viewer.hasUnread) : views,
		...(cursor ? { cursor: pageCursor(cursor) } : {}),
	};
};

export const registerThreadRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);

	route(server, social.colibri.beta.thread.getThread, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetThread(ctx, threads, params.thread, caller.credentials.did),
		}),
	});

	route(server, social.colibri.beta.thread.listMembers, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const row = await threads.row(params.thread);
			if (!row) throw threadNotFound(params.thread);

			const viewer = caller.credentials.did;
			const [authz, channel] = await Promise.all([
				ctx.loader.authz(row.community, viewer),
				ctx.loader.channel(row.channel),
			]);
			if (!channel || !canReadThread(authz, channel, toThreadState(row))) {
				throw forbidden("the requester may not read this thread");
			}

			const members = await threads.members(row);
			return {
				encoding: "application/json" as const,
				body: { members: members.map(asDid) },
			};
		},
	});

	route(server, social.colibri.beta.thread.listThreads, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleListThreads(ctx, threads, params, caller.credentials.did),
		}),
	});
};
