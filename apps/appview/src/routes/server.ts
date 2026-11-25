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

export const resolveVersion = (): string => process.env.VERSION || readPackageVersion();

export const describeServer = (ctx: AppContext): ServerDescription => {
	const features: string[] = [];
	if (ctx.config.VOICE_ENABLED) features.push("voice");
	if (ctx.config.pushProviders.length > 0) features.push("push");
	if (ctx.config.gifsEnabled) features.push("gifs");
	features.push("embeds");
	features.push("emoji");
	if (ctx.clustered) features.push("nodes");

	return {
		did: asDid(ctx.config.APPVIEW_DID),
		software: SOFTWARE,
		flavor: ctx.config.APPVIEW_FLAVOR,
		version: resolveVersion(),
		handleDomain: ctx.config.COMMUNITY_HANDLE_DOMAIN,
		pds: asUri(ctx.config.PDS_URL),
		features,
		spaceTypes: Object.values(SPACE_TYPES).map(asNsid),
		...(ctx.config.DEFAULT_COMMUNITY_DID
			? { defaultCommunity: asDid(ctx.config.DEFAULT_COMMUNITY_DID) }
			: {}),
	};
};

export const listNodes = async (
	ctx: AppContext,
): Promise<social.colibri.beta.server.listNodes.$OutputBody> => {
	if (!ctx.clustered) {
		return { nodes: [] };
	}

	const nodes = await ctx.registry.accepting();

	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			region: node.region,
			roles: node.roles,
			endpoint: asUri(node.publicUrl),
			probeUrl: asUri(new URL("/health", node.publicUrl).toString()),
		})),
	};
};

export const registerServerRoutes = ({ server, ctx }: RouteDeps): void => {
	publicRoute(server, social.colibri.beta.server.listNodes, {
		handler: async () => ({
			encoding: "application/json" as const,
			body: await listNodes(ctx),
		}),
	});
	publicRoute(server, social.colibri.beta.server.describeServer, {
		handler: async () => ({
			encoding: "application/json" as const,
			body: describeServer(ctx),
		}),
	});
};
