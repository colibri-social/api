import { XRPCError } from "@atproto/xrpc-server";
import type { ErrorRequestHandler } from "express";
import type { Logger } from "./logger.js";
import { reportFailure } from "./sentry.js";

export const respondWithError =
	(log: Pick<Logger, "error">): ErrorRequestHandler =>
	(error: unknown, _req, res, next) => {
		const xrpcError = XRPCError.fromError(error);
		if (xrpcError.statusCode >= 500) {
			reportFailure(error, { stage: "route", status: xrpcError.statusCode });
			log.error(
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

		if (res.headersSent) {
			next(error);
			return;
		}
		res.status(xrpcError.statusCode).json(xrpcError.payload);
	};
