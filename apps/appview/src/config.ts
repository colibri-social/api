import {
	configuredProviders,
	type NotificationsConfig,
	parseFcmServiceAccountJson,
} from "@colibri-social/notifications";
import { z } from "zod";
import { DEVELOPMENT_ORIGINS, parseOrigins } from "./cors.js";
import { isLegacyJetstreamUrl, jetstreamEndpoint } from "./jetstream-url.js";

const BARE_IP_DID_WEB = /^did:web:(\d{1,3}\.){3}\d{1,3}(%3A\d+)?$/i;

const optionalString = z
	.string()
	.trim()
	.min(1)
	.optional()
	.or(z.literal("").transform(() => undefined));

const boolish = (fallback: boolean) =>
	z
		.string()
		.optional()
		.transform((value) => (value === undefined || value === "" ? fallback : value !== "false"));

export const configSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	HOST: z.string().default("0.0.0.0"),
	LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

	APPVIEW_DID: z
		.string()
		.startsWith("did:web:")
		.refine((value) => !BARE_IP_DID_WEB.test(value), {
			message:
				"a did:web host must be a name, not an IP address: a PDS refuses a bare IP as a service-auth audience. Use did:web:spaces-api.colibri.social and keep listening on 127.0.0.1",
		}),
	PUBLIC_URL: z.url(),
	CORS_ORIGINS: optionalString,
	SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 64 hex characters"),
	CREDENTIAL_ENCRYPTION_KEY: z.string(),

	DATABASE_URL: z.string().default("file:./data/colibri.db"),
	DATABASE_AUTH_TOKEN: optionalString,
	DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),

	PDS_URL: z.url(),
	PDS_ADMIN_PASSWORD: optionalString,
	PDS_REQUIRES_INVITE: boolish(false),
	COMMUNITY_HANDLE_DOMAIN: z.string(),
	COMMUNITY_EMAIL_DOMAIN: optionalString,

	PLC_URL: z.url().default("https://plc.directory"),
	JETSTREAM_URL: z
		.url()
		.refine(
			(value) => !isLegacyJetstreamUrl(value),
			"points at the legacy Jetstream v1 /subscribe endpoint. Drop the path and use a v2 host such as wss://jetstream.us-west.bsky.network",
		)
		.default("wss://jetstream.us-west.bsky.network"),
	JETSTREAM_ENABLED: boolish(true),

	SYNC_WORKERS: z.coerce.number().int().positive().default(16),
	SYNC_WORKER_THREADS: z.coerce.number().int().nonnegative().default(0),
	SYNC_SWEEP_SECONDS: z.coerce.number().int().positive().default(300),
	SERVICE_AUTH_MAX_LIFETIME_SECONDS: z.coerce.number().int().positive().default(300),

	BLOB_CACHE_MAX_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(256 * 1024 * 1024),

	VAPID_PUBLIC_KEY: optionalString,
	VAPID_PRIVATE_KEY: optionalString,
	VAPID_SUBJECT: optionalString,
	FCM_SERVICE_ACCOUNT_JSON: optionalString,
	KLIPY_API_KEY: optionalString,

	VOICE_ENABLED: boolish(true),
	SFU_WORKER_COUNT: z.coerce.number().int().positive().optional(),
	SFU_LISTEN_IP: z.string().default("0.0.0.0"),
	SFU_ANNOUNCED_IP: optionalString,
	SFU_RTC_MIN_PORT: z.coerce.number().int().positive().default(40000),
	SFU_RTC_MAX_PORT: z.coerce.number().int().positive().default(40100),
	SFU_ICE_SERVERS: optionalString,

	APPVIEW_FLAVOR: z.string().trim().min(1).default("vanilla"),

	SENTRY_DSN: optionalString,
	ADMIN_PASSWORD: optionalString,
});

export type RawConfig = z.infer<typeof configSchema>;

export type Config = RawConfig & {
	canProvisionCommunities: boolean;
	pushProviders: Array<"webpush" | "fcm">;
	notifications: NotificationsConfig;
	gifsEnabled: boolean;
	corsOrigins: string[];
};

export class ConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(`invalid configuration:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
		this.name = "ConfigError";
	}
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
	const parsed = configSchema.safeParse(env);
	if (!parsed.success) {
		throw new ConfigError(
			parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
		);
	}

	const raw = parsed.data;
	const notifications: NotificationsConfig = {
		...(raw.VAPID_PUBLIC_KEY && raw.VAPID_PRIVATE_KEY && raw.VAPID_SUBJECT
			? {
					vapid: {
						publicKey: raw.VAPID_PUBLIC_KEY,
						privateKey: raw.VAPID_PRIVATE_KEY,
						subject: raw.VAPID_SUBJECT,
					},
				}
			: {}),
		...(raw.FCM_SERVICE_ACCOUNT_JSON
			? { fcm: parseFcmServiceAccountJson(raw.FCM_SERVICE_ACCOUNT_JSON) }
			: {}),
	};
	const pushProviders = configuredProviders(notifications);

	const corsOrigins = raw.CORS_ORIGINS
		? parseOrigins(raw.CORS_ORIGINS)
		: raw.NODE_ENV === "production"
			? []
			: DEVELOPMENT_ORIGINS;

	return {
		...raw,
		canProvisionCommunities: Boolean(raw.PDS_ADMIN_PASSWORD),
		pushProviders,
		notifications,
		gifsEnabled: Boolean(raw.KLIPY_API_KEY),
		corsOrigins,
	};
};

export const describeConfig = (config: Config): Record<string, string> => ({
	identity: config.APPVIEW_DID,
	flavor: config.APPVIEW_FLAVOR,
	database: config.DATABASE_URL.startsWith("postgres") ? "postgres" : "libsql",
	pds: config.PDS_URL,
	communities: config.canProvisionCommunities
		? "can be created"
		: "read only, no PDS admin password",
	push: config.pushProviders.length ? config.pushProviders.join(" and ") : "disabled",
	gifs: config.gifsEnabled ? "enabled" : "disabled",
	voice: config.VOICE_ENABLED ? "enabled" : "disabled",
	cors: config.corsOrigins.length ? config.corsOrigins.join(" ") : "no browser origin allowed",
	jetstream: config.JETSTREAM_ENABLED
		? jetstreamEndpoint(config.JETSTREAM_URL).toString()
		: "disabled",
});
