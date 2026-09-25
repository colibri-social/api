import { z } from "zod";

const schema = z.object({
	COLIBRI_APPVIEW_URL: z.url(),
	COLIBRI_APPVIEW_DID: z.string().startsWith("did:").optional(),
	BRIDGE_DID: z.string().startsWith("did:"),
	BRIDGE_SIGNING_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "a 64 character hex private key"),
	DISCORD_TOKEN: z.string().min(1),
	BRIDGE_DATABASE_PATH: z.string().default("./data/bridge.sqlite"),
	BRIDGE_HTTP_PORT: z.coerce.number().int().positive().optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type BridgeConfig = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BridgeConfig => {
	const parsed = schema.safeParse(env);
	if (parsed.success) return parsed.data;
	const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
	throw new Error(`the bridge is not configured correctly:\n${problems.join("\n")}`);
};
