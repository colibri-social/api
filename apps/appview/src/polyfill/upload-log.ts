import type { IncomingMessage } from "node:http";
import { social } from "@colibri-social/lexicons";
import type { Request, Response } from "express";
import { NODE_ID_HEADER } from "../cluster/protocol.js";
import type { Logger } from "../logger.js";
import { xrpcMethod } from "../metrics.js";

const UPLOAD_NSID = social.colibri.beta.polyfill.uploadBlob.$nsid;

const LOGGED_RESPONSE_CHARS = 500;

const headerOf = (request: IncomingMessage, name: string): string | null => {
	const value = request.headers[name];

	return Array.isArray(value) ? value.join(", ") : (value ?? null);
};

const textOf = (chunk: unknown): string | null => {
	if (typeof chunk === "string") {
		return chunk;
	}

	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk).toString("utf8");
	}

	return null;
};

export const logRejectedUploads = (log: Pick<Logger, "warn">, node: string | null) => {
	return (req: Request, res: Response, next: () => void) => {
		if (xrpcMethod(req.path) !== UPLOAD_NSID) {
			next();

			return;
		}

		const end = res.end.bind(res) as (...args: unknown[]) => Response;
		let response: string | null = null;

		res.end = ((...args: unknown[]) => {
			response = textOf(args[0]);

			return end(...args);
		}) as Response["end"];

		res.once("finish", () => {
			if (res.statusCode < 400) {
				return;
			}

			log.warn(
				{
					status: res.statusCode,
					response: response?.slice(0, LOGGED_RESPONSE_CHARS) ?? null,
					contentType: headerOf(req, "content-type"),
					contentLength: headerOf(req, "content-length"),
					transferEncoding: headerOf(req, "transfer-encoding"),
					contentEncoding: headerOf(req, "content-encoding"),
					forwardedFrom: headerOf(req, NODE_ID_HEADER),
					node,
				},
				"polyfill.uploadRejected",
			);
		});

		next();
	};
};
