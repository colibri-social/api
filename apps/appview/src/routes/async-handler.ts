import type { Request, RequestHandler, Response } from "express";
import type { AppContext } from "../context.js";
import { reportFailure } from "../sentry.js";

export const asyncHandler =
	(
		ctx: AppContext,
		event: string,
		run: (req: Request, res: Response) => Promise<void>,
	): RequestHandler =>
	(req, res) => {
		try {
			return run(req, res).catch((error: unknown) => {
				onHandlerError(ctx, event, error, req, res);
			});
		} catch (error) {
			onHandlerError(ctx, event, error, req, res);
			return Promise.resolve();
		}
	};

const onHandlerError = (
	ctx: AppContext,
	event: string,
	error: unknown,
	req: Request,
	res: Response,
): void => {
	reportFailure(error, { stage: "route", route: event });
	ctx.log.error({ err: error, path: req.path }, event);

	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.status(500).json({ error: "InternalServerError", message: "something went wrong" });
};
