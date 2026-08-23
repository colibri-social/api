import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asDid, asNsid, asUri, SPACE_TYPES, social } from "@colibri-social/lexicons";
import type { AppContext } from "../context.js";
import { publicRoute } from "../route.js";
import type { RouteDeps } from "./types.js";

type ServerDescription = social.colibri.beta.server.describeServer.$OutputBody;

const SOFTWARE = "colibri-appview";

const readPackageVersion = (): string => {
	try {
		const path = fileURLToPath(new URL("../../package.json", import.meta.url));
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
		return parsed.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
};

const resolveVersion = (): string => process.env.VERSION || readPackageVersion();

export const describeServer = (ctx: AppContext): ServerDescription => {
	const features: string[] = [];
	if (ctx.config.VOICE_ENABLED) features.push("voice");
	if (ctx.config.pushProviders.length > 0) features.push("push");
	if (ctx.config.gifsEnabled) features.push("gifs");
	features.push("embeds");

	return {
		did: asDid(ctx.config.APPVIEW_DID),
		software: SOFTWARE,
		flavor: ctx.config.APPVIEW_FLAVOR,
		version: resolveVersion(),
		handleDomain: ctx.config.COMMUNITY_HANDLE_DOMAIN,
		pds: asUri(ctx.config.PDS_URL),
		features,
		spaceTypes: Object.values(SPACE_TYPES).map(asNsid),
	};
};

export const registerServerRoutes = ({ server, ctx }: RouteDeps): void => {
	publicRoute(server, social.colibri.beta.server.describeServer, {
		handler: async () => ({
			encoding: "application/json" as const,
			body: describeServer(ctx),
		}),
	});
};
