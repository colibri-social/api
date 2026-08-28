import { BlobNotFoundError, BlobRejectedError, type Variant } from "@colibri-social/blobs";
import { decideSpaceAccess } from "@colibri-social/community";
import { tryParseSpaceRef } from "@colibri-social/space";
import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { verifyMediaGrant } from "../media-token.js";
import { asyncHandler } from "./async-handler.js";

const VARIANTS: readonly Variant[] = ["thumbnail", "avatar", "banner", "full"];

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const asVariant = (value: unknown): Variant | undefined => {
	const name = asString(value);
	return name && (VARIANTS as readonly string[]).includes(name) ? (name as Variant) : undefined;
};

const bearerToken = (value: string | string[] | undefined): string | null => {
	if (!value || Array.isArray(value)) return null;
	return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
};

type SpaceViewer =
	| { authorized: true }
	| { authorized: false; status: 401 | 403; error: string; message: string };

const forbid = (message: string): SpaceViewer => ({
	authorized: false,
	status: 403,
	error: "Forbidden",
	message,
});

const unauthenticated = (message: string): SpaceViewer => ({
	authorized: false,
	status: 401,
	error: "AuthRequired",
	message,
});

export const mountBlobRoutes = (ctx: AppContext, app: Router): void => {
	const viewerForSpace = async (
		req: Request,
		did: string,
		cid: string,
		space: string,
	): Promise<SpaceViewer> => {
		const parsed = tryParseSpaceRef(space);
		if (!parsed) return forbid("that is not a space reference");

		const signature = asString(req.query.sig);
		const expiresAt = Number(asString(req.query.exp));
		const now = Math.floor(Date.now() / 1000);

		let viewer: string | null = null;
		if (signature) {
			const signedViewer = asString(req.query.viewer) ?? null;
			const candidate = signedViewer ?? null;
			if (candidate === null) {
				return unauthenticated("this media link is missing its viewer");
			}
			if (
				!verifyMediaGrant(
					ctx.config.SIGNING_KEY,
					{ did, cid, space: parsed.uri, viewer: candidate },
					expiresAt,
					signature,
					now,
				)
			) {
				return unauthenticated("this media link is invalid or has expired");
			}
			viewer = candidate;
		} else {
			const token = bearerToken(req.headers.authorization);
			if (!token) {
				return unauthenticated("a blob in a permissioned space needs service auth or a media link");
			}
			try {
				const caller = await ctx.serviceAuth.verify(token, "social.colibri.beta.blob.get");
				viewer = caller.did;
			} catch (error) {
				return unauthenticated(
					error instanceof Error ? error.message : "service auth could not be verified",
				);
			}
		}

		const authz = await ctx.loader.authz(parsed.authority, viewer);
		const channel = await ctx.loader.channel(parsed.uri);
		const decision = decideSpaceAccess({
			spaceType: parsed.spaceType,
			authz,
			visibility: { profileIsPublic: false },
			channel,
		});
		if (!decision.authorized) return forbid(decision.reason);
		return { authorized: true };
	};

	app.get(
		"/xrpc/social.colibri.beta.blob.get",
		asyncHandler(ctx, "blob.get.failed", async (req: Request, res: Response) => {
			const did = asString(req.query.did);
			const cid = asString(req.query.cid);
			if (!did || !cid) {
				res.status(400).json({ error: "InvalidRequest", message: "did and cid are required" });
				return;
			}

			const space = asString(req.query.space);
			const variant = asVariant(req.query.variant);
			const range = asString(req.headers.range);

			if (space) {
				const outcome = await viewerForSpace(req, did, cid, space);
				if (!outcome.authorized) {
					res.status(outcome.status).json({ error: outcome.error, message: outcome.message });
					return;
				}
			}

			try {
				const blob = await ctx.blobs.fetch({
					did,
					cid,
					...(space ? { space } : {}),
					...(variant ? { variant } : {}),
					...(range ? { range } : {}),
				});

				if (blob.status === "rangeNotSatisfiable") {
					res.setHeader("content-range", `bytes */${blob.totalSize}`);
					res.status(416).end();
					return;
				}

				res.setHeader("content-type", blob.mimeType);
				res.setHeader("accept-ranges", "bytes");
				res.setHeader("etag", `"${cid}"`);
				res.setHeader(
					"cache-control",
					space ? "private, max-age=31536000, immutable" : "public, max-age=31536000, immutable",
				);
				if (space) res.setHeader("vary", "authorization");

				const filename = asString(req.query.filename);
				if (filename) {
					res.setHeader(
						"content-disposition",
						`attachment; filename="${encodeURIComponent(filename)}"`,
					);
				}

				if (blob.range) {
					res.setHeader(
						"content-range",
						`bytes ${blob.range.start}-${blob.range.end}/${blob.totalSize}`,
					);
					res.status(206);
				}

				res.setHeader("content-length", String(blob.bytes.byteLength));
				res.end(Buffer.from(blob.bytes));
			} catch (error) {
				if (error instanceof BlobNotFoundError) {
					res.status(404).json({ error: "BlobNotFound", message: error.message });
					return;
				}
				if (error instanceof BlobRejectedError) {
					const status = error.reason === "cidMismatch" ? 502 : 400;
					res.status(status).json({ error: "InvalidRequest", message: error.message });
					return;
				}
				ctx.log.warn({ did, cid, error }, "blob.failed");
				res.status(502).json({ error: "UpstreamFailure", message: "could not serve this blob" });
			}
		}),
	);
};
