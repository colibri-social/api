import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";

const CACHE_CONTROL = "public, max-age=300";

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

export const mountIdentityRoutes = (ctx: AppContext, app: Router): void => {
	const resolveHandle = async (req: Request, res: Response): Promise<void> => {
		const handle = asString(req.query.handle);
		if (!handle) {
			res.status(400).json({ error: "InvalidRequest", message: "handle is required" });
			return;
		}

		try {
			const did = await ctx.identity.resolveHandle(handle.toLowerCase());
			res.setHeader("cache-control", CACHE_CONTROL);
			res.json({ did });
		} catch {
			res
				.status(400)
				.json({ error: "InvalidRequest", message: `unable to resolve handle ${handle}` });
		}
	};

	const resolveDid = async (req: Request, res: Response): Promise<void> => {
		const did = asString(req.query.did);
		if (!did) {
			res.status(400).json({ error: "InvalidRequest", message: "did is required" });
			return;
		}

		try {
			const identity = await ctx.identity.resolveDid(did);
			res.setHeader("cache-control", CACHE_CONTROL);
			res.json({
				did,
				...(identity.handle ? { handle: identity.handle } : {}),
				...(identity.pds ? { pds: identity.pds } : {}),
			});
		} catch {
			res.status(400).json({ error: "InvalidRequest", message: `unable to resolve ${did}` });
		}
	};

	app.get("/xrpc/com.atproto.identity.resolveHandle", (req, res) => {
		void resolveHandle(req, res);
	});

	app.get("/xrpc/com.atproto.identity.resolveDid", (req, res) => {
		void resolveDid(req, res);
	});
};
