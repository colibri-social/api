import { z } from "zod";

export const SERVICE_FRAGMENTS = {
	appview: "colibri_appview",
	notifs: "colibri_notifs",
	syncer: "atproto_space_syncer",
} as const;

export const identityConfigSchema = z.object({
	did: z
		.string()
		.startsWith("did:web:", "the AppView must identify as a did:web it controls")
		.describe("The did:web this AppView answers as."),
	publicUrl: z.url().describe("Where this AppView is reachable from the public internet."),
	signingKeyHex: z
		.string()
		.regex(/^[0-9a-fA-F]{64}$/, "expected a 64-character hex secp256k1 private key"),
	plcUrl: z.url().default("https://plc.directory"),
	didCacheStaleSeconds: z
		.number()
		.int()
		.positive()
		.default(60 * 60),
	didCacheMaxSeconds: z
		.number()
		.int()
		.positive()
		.default(24 * 60 * 60),
	maxServiceAuthLifetimeSeconds: z.number().int().positive().default(300),
});

export type IdentityConfig = z.infer<typeof identityConfigSchema>;

export const hostFromDidWeb = (did: string): string =>
	decodeURIComponent(did.slice("did:web:".length)).replaceAll(":", "/");

export const serviceId = (did: string, fragment: string) => `${did}#${fragment}`;
