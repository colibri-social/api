import type { NextFunction, Request, Response } from "express";

export const WILDCARD = "*";

const ALLOWED_METHODS = "GET, POST, OPTIONS";

const ALLOWED_HEADERS = [
	"authorization",
	"atproto-proxy",
	"atproto-accept-labelers",
	"content-type",
	"range",
].join(", ");

const EXPOSED_HEADERS = ["atproto-repo-rev", "accept-ranges", "content-range"].join(", ");

const PREFLIGHT_MAX_AGE_SECONDS = "86400";

export const parseOrigins = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((origin) => origin.trim().replace(/\/$/, ""))
		.filter(Boolean);

export const DEVELOPMENT_ORIGINS = ["http://localhost:4321", "http://127.0.0.1:4321"];

export const corsMiddleware = (origins: readonly string[]) => {
	const wildcard = origins.includes(WILDCARD);
	const allowed = new Set(origins);

	return (req: Request, res: Response, next: NextFunction): void => {
		if (!wildcard) res.append("Vary", "Origin");

		const origin = req.headers.origin;
		if (typeof origin === "string" && (wildcard || allowed.has(origin))) {
			res.setHeader("Access-Control-Allow-Origin", wildcard ? WILDCARD : origin);
			res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
		}

		if (req.method !== "OPTIONS") {
			next();
			return;
		}

		res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
		res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
		res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
		res.status(204).end();
	};
};
