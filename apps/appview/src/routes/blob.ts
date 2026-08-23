import { BlobNotFoundError, BlobRejectedError, type Variant } from "@colibri-social/blobs";
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";

const VARIANTS: readonly Variant[] = ["thumbnail", "avatar", "banner", "full"];

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const asVariant = (value: unknown): Variant | undefined => {
	const name = asString(value);
	return name && (VARIANTS as readonly string[]).includes(name) ? (name as Variant) : undefined;
};

export const mountBlobRoutes = (ctx: AppContext, app: Express): void => {
	app.get("/xrpc/social.colibri.blob.get", async (req: Request, res: Response) => {
		const did = asString(req.query.did);
		const cid = asString(req.query.cid);
		if (!did || !cid) {
			res.status(400).json({ error: "InvalidRequest", message: "did and cid are required" });
			return;
		}

		const space = asString(req.query.space);
		const variant = asVariant(req.query.variant);
		const range = asString(req.headers.range);

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
			res.setHeader("cache-control", "public, max-age=31536000, immutable");

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
	});
};
