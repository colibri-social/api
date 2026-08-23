import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asDid, asNsid, asUri, SPACE_TYPES, social } from "@colibri-social/lexicons";
import { publicRoute } from "../route.js";
import type { RouteDeps } from "./types.js";

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

export const registerServerRoutes = ({ server, ctx }: RouteDeps): void => {
	publicRoute(server, social.colibri.server.describeServer, {
		handler: async () => {
			const features: string[] = [];
			if (ctx.config.VOICE_ENABLED) features.push("voice");
			if (ctx.config.pushProviders.length > 0) features.push("push");
			if (ctx.config.gifsEnabled) features.push("gifs");
			features.push("embeds");

			return {
				encoding: "application/json" as const,
				body: {
					did: asDid(ctx.config.APPVIEW_DID),
					version: resolveVersion(),
					handleDomain: ctx.config.COMMUNITY_HANDLE_DOMAIN,
					pds: asUri(ctx.config.PDS_URL),
					features,
					spaceTypes: Object.values(SPACE_TYPES).map(asNsid),
				},
			};
		},
	});
};
