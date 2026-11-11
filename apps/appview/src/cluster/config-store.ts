import type { Database } from "@colibri-social/appview-db";
import type { SecretBox } from "@colibri-social/community";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { configSchema } from "../config.js";

export const NODE_LOCAL_KEYS: ReadonlySet<string> = new Set([
	"NODE_ID",
	"NODE_REGION",
	"NODE_PUBLIC_URL",
	"NODE_TAILNET_URL",
	"ROLES",
	"MAIN_NODE_URL",
	"CLUSTER_JOIN_TOKEN",
	"NODE_SECRET_FILE",
	"CLUSTER_PORT",
	"PORT",
	"HOST",
	"DATABASE_READ_URL",
	"SFU_ANNOUNCED_IP",
	"SFU_LISTEN_IP",
	"SFU_WORKER_COUNT",
	"SFU_RTC_PORT",
	"SSH_KEY_FILE",
	"TAILSCALE_AUTH_KEY",
	"POSTGRES_REPLICATION_PASSWORD",
	"REGISTRY_TOKEN",
	"ANSIBLE_DIR",
	"STACK_DIR",
	"METRICS_HOST",
	"METRICS_PORT",
	"BLOB_DISK_CACHE_DIR",
	"BLOB_DISK_CACHE_MAX_BYTES",
	"BLOB_RENDER_CONCURRENCY",
]);

const sealedSchema = z.object({ c: z.string(), n: z.string() });

export const isSharedKey = (key: string): boolean => {
	return key in configSchema.shape && !NODE_LOCAL_KEYS.has(key);
};

export type ConfigStore = {
	set: (key: string, value: string) => Promise<void>;
	unset: (key: string) => Promise<boolean>;
	keys: () => Promise<string[]>;
	values: () => Promise<Record<string, string>>;
};

export const createConfigStore = (
	database: Pick<Database, "primary" | "tables">,
	box: SecretBox,
	now: () => Date = () => new Date(),
): ConfigStore => {
	const { primary, tables } = database;
	const table = tables.clusterConfig;

	return {
		set: async (key, value) => {
			if (!isSharedKey(key)) {
				throw new Error(`${key} is not a setting every node shares`);
			}

			const sealed = await box.seal(value);
			const row = {
				key,
				ciphertext: JSON.stringify({ c: sealed.ciphertextBase64, n: sealed.nonceBase64 }),
				updatedAt: now().toISOString(),
			};

			await primary.insert(table).values(row).onConflictDoUpdate({ target: table.key, set: row });
		},
		unset: async (key) => {
			const removed = await primary
				.delete(table)
				.where(eq(table.key, key))
				.returning({ key: table.key });

			return removed.length > 0;
		},
		keys: async () => {
			const rows = await primary.select({ key: table.key }).from(table).orderBy(table.key);

			return rows.map((row) => row.key);
		},
		values: async () => {
			const rows = await primary.select().from(table);
			const entries = await Promise.all(
				rows.map(async (row) => {
					const sealed = sealedSchema.parse(JSON.parse(row.ciphertext));
					const value = await box.open({ ciphertextBase64: sealed.c, nonceBase64: sealed.n });

					return [row.key, value] as const;
				}),
			);

			return Object.fromEntries(entries);
		},
	};
};
