import { createServer, type Server, XRPCError } from "@atproto/xrpc-server";
import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { authVerifiers } from "./auth.js";
import type { AppContext } from "./context.js";
import { corsMiddleware } from "./cors.js";
import { registerActorRoutes } from "./routes/actor.js";
import { registerActorWriteRoutes } from "./routes/actor-write.js";
import { asyncHandler } from "./routes/async-handler.js";
import { mountBlobRoutes } from "./routes/blob.js";
import { registerCategoryRoutes } from "./routes/category.js";
import { registerChannelRoutes } from "./routes/channel.js";
import { registerChannelWriteRoutes } from "./routes/channel-write.js";
import { registerCommunityRoutes } from "./routes/community.js";
import { registerCommunityWriteRoutes } from "./routes/community-write.js";
import { registerEmbedRoutes } from "./routes/embed.js";
import { mountEmbedMediaRoutes } from "./routes/embed-media.js";
import { mountIdentityRoutes } from "./routes/identity.js";
import { registerModerationRoutes } from "./routes/moderation.js";
import { registerNotificationRoutes } from "./routes/notification.js";
import { registerProtocolRoutes } from "./routes/protocol.js";
import { registerRoleRoutes } from "./routes/role.js";
import { registerServerRoutes } from "./routes/server.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { reportFailure } from "./sentry.js";

const BANNER = `           _ _ _          _                  _       _
          | (_) |        (_)                (_)     | |
  ___ ___ | |_| |__  _ __ _   ___  ___   ___ _  __ _| |
 / __/ _ \\| | | '_ \\| '__| | / __|/ _ \\ / __| |/ _\` | |
| (_| (_) | | | |_) | |  | |_\\__ \\ (_) | (__| | (_| | |
 \\___\\___/|_|_|_.__/|_|  |_(_)___/\\___/ \\___|_|\\__,_|_|


This is an AT Protocol Application View (AppView) for the "colibri.social" application.

Most API routes are under /xrpc/

Docs: https://colibri.social/docs
Code: https://github.com/colibri-social/appview
Protocol: https://atproto.com
`;

export const createAppServer = (ctx: AppContext): Server => {
	const server = createServer(undefined, {
		payload: { jsonLimit: 1_000_000, blobLimit: 20 * 1024 * 1024 },
		catchall: undefined,
		errorParser: (error) => {
			const xrpcError = XRPCError.fromError(error);
			if (xrpcError.statusCode >= 500) {
				reportFailure(error, { stage: "route", status: xrpcError.statusCode });
				ctx.log.error(
					{
						name: error instanceof Error ? error.name : typeof error,
						status: xrpcError.statusCode,
						reason: error instanceof Error ? error.message : String(error),
						cause:
							error instanceof Error && error.cause instanceof Error
								? error.cause.message
								: undefined,
						stack: error instanceof Error ? error.stack : undefined,
					},
					"route.unhandled",
				);
			}
			return xrpcError;
		},
	});

	const app = server.routes;
	app.use(corsMiddleware(ctx.config.corsOrigins));

	const auth = authVerifiers(ctx);
	const deps = { server, ctx, auth };

	registerProtocolRoutes(deps);
	registerActorRoutes(deps);
	registerActorWriteRoutes(deps);
	registerCommunityRoutes(deps);
	registerCommunityWriteRoutes(deps);
	registerModerationRoutes(deps);
	registerCategoryRoutes(deps);
	registerRoleRoutes(deps);
	registerChannelRoutes(deps);
	registerChannelWriteRoutes(deps);
	registerVoiceRoutes(deps);
	registerEmbedRoutes(deps);
	registerNotificationRoutes(deps);
	registerServerRoutes(deps);
	// NOTE: Humming was dropped with the rebuild, implementation follows after reconsideration

	app.get("/", (_req: Request, res: Response) => {
		res.type("text/plain").send(BANNER);
	});

	app.get(
		"/health",
		asyncHandler(ctx, "health.failed", async (_req: Request, res: Response) => {
			try {
				await ctx.database.db.run(sql`select 1`);
			} catch (error) {
				ctx.log.error({ err: error }, "health.databaseUnreachable");
				res.status(503).json({ status: "degraded", did: ctx.config.APPVIEW_DID, database: "down" });
				return;
			}
			res.json({ status: "ok", did: ctx.config.APPVIEW_DID, database: "up" });
		}),
	);

	app.get("/.well-known/did.json", (_req: Request, res: Response) => {
		res.json(ctx.didDocument);
	});

	mountBlobRoutes(ctx, app);
	mountEmbedMediaRoutes(ctx, app);
	mountIdentityRoutes(ctx, app);

	return server;
};
