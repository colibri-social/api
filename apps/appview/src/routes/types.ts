import type { Server } from "@atproto/xrpc-server";
import type { AuthVerifiers } from "../auth.js";
import type { AppContext } from "../context.js";

export type RouteDeps = {
	server: Server;
	ctx: AppContext;
	auth: AuthVerifiers;
};
