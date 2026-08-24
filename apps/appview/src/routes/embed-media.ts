import { guardedFetch, isEmbedError } from "@colibri-social/embeds";
import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { type EmbedMediaKind, verifyEmbedToken } from "../embed-token.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const CACHE_CONTROL = "public, max-age=900, immutable";

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const baseType = (header: string | undefined): string =>
	(header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const fail = (res: Response, status: number, error: string, message: string): void => {
	res.status(status).json({ error, message });
};

export const mountEmbedMediaRoutes = (ctx: AppContext, app: Router): void => {
	const serve = async (kind: EmbedMediaKind, req: Request, res: Response): Promise<void> => {
		const target = asString(req.query.url);
		const signature = asString(req.query.sig);
		const expiresAt = Number(asString(req.query.exp));

		if (!target || !signature || !Number.isFinite(expiresAt)) {
			fail(res, 400, "InvalidRequest", "url, exp and sig are all required");
			return;
		}

		const now = Math.floor(Date.now() / 1000);
		if (!verifyEmbedToken(ctx.config.SIGNING_KEY, kind, target, expiresAt, signature, now)) {
			fail(res, 403, "Forbidden", "this link is not valid for this appview");
			return;
		}

		const range = req.headers.range;
		const allowed = kind === "image" ? IMAGE_TYPES : VIDEO_TYPES;
		const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;

		let upstream: Awaited<ReturnType<typeof guardedFetch>>;
		try {
			upstream = await guardedFetch(target, {
				maxResponseBytes: cap,
				headers: {
					accept: kind === "image" ? "image/*" : "video/*",
					...(typeof range === "string" ? { range } : {}),
				},
			});
		} catch (error) {
			const reason = isEmbedError(error) ? error.reason : "could not be fetched";
			ctx.log.debug({ kind, reason }, "embed.fetchFailed");
			fail(res, 502, "NotFetchable", reason);
			return;
		}

		if (upstream.statusCode >= 400) {
			fail(res, 502, "NotFetchable", `the origin answered ${upstream.statusCode}`);
			return;
		}

		const mimeType = baseType(upstream.headers["content-type"]);
		if (!allowed.has(mimeType)) {
			fail(res, 415, "UnsupportedImage", `the origin served ${mimeType || "no content type"}`);
			return;
		}

		res.status(upstream.statusCode === 206 ? 206 : 200);
		res.setHeader("content-type", mimeType);
		res.setHeader("content-length", String(upstream.body.byteLength));
		res.setHeader("cache-control", CACHE_CONTROL);
		res.setHeader("accept-ranges", "bytes");
		res.setHeader("x-content-type-options", "nosniff");
		const contentRange = upstream.headers["content-range"];
		if (contentRange) res.setHeader("content-range", contentRange);
		res.end(upstream.body);
	};

	app.get("/xrpc/social.colibri.beta.embed.getImage", (req, res) => {
		void serve("image", req, res);
	});

	app.get("/xrpc/social.colibri.beta.embed.getVideo", (req, res) => {
		void serve("video", req, res);
	});
};
