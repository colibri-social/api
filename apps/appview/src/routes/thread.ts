import { InvalidRequestError } from "@atproto/xrpc-server";
import { social } from "@colibri-social/lexicons";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { route } from "../route.js";
import { ActorViews } from "../views/actor.js";
import { ChannelViews } from "../views/channel.js";
import { type ThreadRow, ThreadViews } from "../views/thread.js";
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

export const registerThreadRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	const actors = new ActorViews(ctx);
	const channels = new ChannelViews(ctx, actors);
	const threads = new ThreadViews(ctx, channels);

	route(server, social.colibri.beta.thread.getThread, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const row = await threads.row(params.thread);
			if (!row) throw threadNotFound(params.thread);

			const viewer = caller.credentials.did;
			const authz = await ctx.loader.authz(row.community, viewer);
			const view = await threads.view(row, authz, viewer, { anchorMessages: true });
			if (!view) throw forbidden("the requester may not read this thread");

			return { encoding: "application/json" as const, body: { thread: view } };
		},
	});

	route(server, social.colibri.beta.thread.listThreads, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => {
			const community = await ctx.loader.community(params.community);
			if (!community) {
				throw new InvalidRequestError(
					`no community matches ${params.community}`,
					"CommunityNotFound",
				);
			}

			const viewer = caller.credentials.did;
			const authz = await ctx.loader.authz(params.community, viewer);
			if (!authz.member && !authz.isOwner) {
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
				if (followed.length === 0) {
					return { encoding: "application/json" as const, body: { threads: [] } };
				}
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
			const views = await threads.views(page, authz, viewer);

			return {
				encoding: "application/json" as const,
				body: {
					threads: params.filter === "unread" ? views.filter((v) => v.viewer.hasUnread) : views,
					...(cursor ? { cursor: pageCursor(cursor) } : {}),
				},
			};
		},
	});
};
