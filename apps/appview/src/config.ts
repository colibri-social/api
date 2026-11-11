import type { NodeRole } from "@colibri-social/appview-db";
import {
	apnsConfigSchema,
	configuredProviders,
	type NotificationsConfig,
	type PushProviderName,
	parseApnsKey,
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

export const NODE_ROLES = [
	"main",
	"failover",
	"api",
	"live",
	"voice",
] as const satisfies readonly NodeRole[];

const DEFAULT_ROLES: NodeRole[] = ["main", "api", "live", "voice"];

const rolesList = z
	.string()
	.optional()
	.transform((value, context) => {
		if (value === undefined || value.trim() === "") {
			return DEFAULT_ROLES;
		}

		const roles = [
			...new Set(
				value
					.split(",")
					.map((role) => role.trim())
					.filter(Boolean),
			),
		];
		const unknown = roles.filter((role) => !NODE_ROLES.includes(role as NodeRole));

		if (unknown.length > 0) {
			context.addIssue({
				code: "custom",
				message: `unknown role ${unknown.join(", ")}, expected any of ${NODE_ROLES.join(", ")}`,
			});

			return z.NEVER;
		}

		return roles as NodeRole[];
	});

const optOut = z
	.string()
	.optional()
	.transform((value) => value !== undefined && value.trim() !== "" && value.trim() !== "0");

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
				"a did:web host must be a name, not an IP address. A PDS refuses a bare IP as a service-auth audience. Use a hostname such as did:web:appview.example.com and keep listening on 127.0.0.1",
		}),
	PUBLIC_URL: z.url(),
	CORS_ORIGINS: optionalString,
	SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 64 hex characters"),
	CREDENTIAL_ENCRYPTION_KEY: z.string(),

	DATABASE_URL: z.string().default("file:./data/colibri.db"),
	DATABASE_AUTH_TOKEN: optionalString,
	DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
	DATABASE_READ_URL: optionalString,

	ROLES: rolesList,
	NODE_ID: optionalString,
	NODE_REGION: optionalString,
	MAIN_NODE_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	NODE_PUBLIC_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	NODE_TAILNET_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	CLUSTER_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
	CLUSTER_JOIN_TOKEN: optionalString,
	NODE_SECRET_FILE: z.string().default("./data/node-secret"),
	NODE_IMAGE: z.string().trim().min(1).default("ghcr.io/colibri-social/api:stable"),
	ANSIBLE_DIR: z.string().default("deploy/ansible"),
	SSH_USER: z.string().trim().min(1).default("root"),
	SSH_KEY_FILE: z.string().default("/run/secrets/colibri_ssh_key"),
	TAILSCALE_AUTH_KEY: optionalString,
	POSTGRES_REPLICATION_PASSWORD: optionalString,
	REGISTRY_USER: optionalString,
	REGISTRY_TOKEN: optionalString,
	STACK_DIR: z.string().trim().min(1).default("/opt/colibri"),
	UPDATE_POLL_MINUTES: z.coerce.number().nonnegative().default(15),
	CLOUDFLARE_API_TOKEN: optionalString,
	CLOUDFLARE_ACCOUNT_ID: optionalString,
	CLOUDFLARE_ZONE_ID: optionalString,
	CLOUDFLARE_LB_ID: optionalString,
	CLOUDFLARE_GEO_REGIONS: optionalString,
	DRAIN_GRACE_MINUTES: z.coerce.number().nonnegative().default(120),
	WRITE_QUEUE_SECONDS: z.coerce.number().int().nonnegative().default(90),
	MESSAGE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(180),

	PDS_URL: z.url(),
	HOST_OAUTH_PRIVATE_KEY: optionalString,
	HOST_OAUTH_KEY_ID: z.string().trim().min(1).default("host-oauth-1"),
	HOST_OAUTH_RETURN_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
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
	SYNC_MAX_CAR_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(64 * 1024 * 1024),
	SYNC_WORKER_THREADS: z.coerce.number().int().nonnegative().default(0),
	SYNC_SWEEP_SECONDS: z.coerce.number().int().positive().default(300),
	THREAD_IDLE_SECONDS: z.coerce
		.number()
		.int()
		.positive()
		.default(7 * 24 * 60 * 60),
	SERVICE_AUTH_MAX_LIFETIME_SECONDS: z.coerce.number().int().positive().default(300),
	HANDLE_CACHE_TTL_SECONDS: z.coerce
		.number()
		.int()
		.positive()
		.default(24 * 60 * 60),
	HANDLE_NEGATIVE_CACHE_TTL_SECONDS: z.coerce
		.number()
		.int()
		.positive()
		.default(5 * 60),
	IDENTITY_CONCURRENCY: z.coerce.number().int().positive().default(12),
	PROFILE_FETCH_CONCURRENCY: z.coerce.number().int().positive().default(8),

	BLOB_CACHE_MAX_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(256 * 1024 * 1024),
	BLOB_DISK_CACHE_DIR: z.string().default("./data/blob-cache"),
	BLOB_DISK_CACHE_MAX_BYTES: z.coerce
		.number()
		.int()
		.nonnegative()
		.default(10 * 1024 * 1024 * 1024),

	VAPID_PUBLIC_KEY: optionalString,
	VAPID_PRIVATE_KEY: optionalString,
	VAPID_SUBJECT: optionalString,
	FCM_SERVICE_ACCOUNT_JSON: optionalString,
	APNS_KEY: optionalString,
	APNS_KEY_ID: optionalString,
	APNS_TEAM_ID: optionalString,
	APNS_TOPIC: optionalString,
	PUSH_ACTION_SECRET: z
		.string()
		.trim()
		.min(32, "expected at least 32 characters, generate one with: openssl rand -base64 32")
		.optional()
		.or(z.literal("").transform(() => undefined)),
	KLIPY_API_KEY: optionalString,
	VIDEO_ARTWORK_ENABLED: boolish(false),

	VOICE_ENABLED: boolish(true),
	SFU_WORKER_COUNT: z.coerce.number().int().positive().optional(),
	SFU_LISTEN_IP: z.string().default("0.0.0.0"),
	SFU_ANNOUNCED_IP: optionalString,
	SFU_ICE_SERVERS: optionalString,
	SFU_RTC_PORT: z.coerce.number().int().min(1).max(65535).default(40000),
	SFU_INITIAL_OUTGOING_BITRATE: z.coerce.number().int().positive().default(3_500_000),
	SFU_PARTICIPANTS_PER_WORKER: z.coerce.number().int().positive().default(20),
	VOICE_MIGRATION_NOTICE_SECONDS: z.coerce.number().int().min(0).default(60),
	TURN_KEY_ID: optionalString,
	TURN_KEY_API_TOKEN: optionalString,

	APPVIEW_FLAVOR: z.string().trim().min(1).default("vanilla"),
	DEFAULT_COMMUNITY_DID: z
		.string()
		.trim()
		.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/, "expected a DID such as did:plc:...")
		.optional()
		.or(z.literal("").transform(() => undefined)),

	SENTRY_DSN: optionalString,
	ADMIN_PASSWORD: optionalString,

	COLIBRI_TELEMETRY_DISABLED: optOut,
	DO_NOT_TRACK: optOut,
});

export type RawConfig = z.infer<typeof configSchema>;

export type Config = RawConfig & {
	canProvisionCommunities: boolean;
	pushProviders: PushProviderName[];
	notifications: NotificationsConfig;
	gifsEnabled: boolean;
	corsOrigins: string[];
	telemetryEnabled: boolean;
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
		...(raw.APNS_KEY && raw.APNS_KEY_ID && raw.APNS_TEAM_ID
			? {
					apns: apnsConfigSchema.parse({
						key: parseApnsKey(raw.APNS_KEY),
						keyId: raw.APNS_KEY_ID,
						teamId: raw.APNS_TEAM_ID,
						topic: raw.APNS_TOPIC,
					}),
				}
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
		telemetryEnabled: !raw.COLIBRI_TELEMETRY_DISABLED && !raw.DO_NOT_TRACK,
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
	pushActions: config.PUSH_ACTION_SECRET ? "enabled" : "disabled, no PUSH_ACTION_SECRET",
	gifs: config.gifsEnabled ? "enabled" : "disabled",
	hostSignIn: config.HOST_OAUTH_PRIVATE_KEY ? "enabled" : "disabled, no HOST_OAUTH_PRIVATE_KEY",
	voice: config.VOICE_ENABLED ? "enabled" : "disabled",
	cors: config.corsOrigins.length ? config.corsOrigins.join(" ") : "no browser origin allowed",
	jetstream: config.JETSTREAM_ENABLED
		? jetstreamEndpoint(config.JETSTREAM_URL).toString()
		: "disabled",
});
