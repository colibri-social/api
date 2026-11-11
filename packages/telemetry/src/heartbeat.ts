import { z } from "zod";

export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;

export const HEARTBEAT_TIMEOUT_MS = 10_000;

export const BUCKETS = ["0", "1-10", "11-100", "101-1k", "1k-10k", "10k+"] as const;

export const TELEMETRY_NOTICE =
	"This AppView sends an anonymous heartbeat once a day: a random instance ID, its version, flavor, roles, node count, database version, OS, Node major version, whether voice is set up, and rough counts of Spaces, users seen in the last 30 days and voice minutes in the last day. Set COLIBRI_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 to turn it off.";

export type Bucket = (typeof BUCKETS)[number];

export const heartbeatSchema = z.object({
	instanceId: z.uuid(),
	version: z.string(),
	flavor: z.string(),
	roles: z.array(z.string()),
	nodes: z.enum(BUCKETS),
	database: z.string(),
	os: z.string(),
	node: z.string(),
	voice: z.boolean(),
	spaces: z.enum(BUCKETS),
	users30d: z.enum(BUCKETS),
	voiceMinutes1d: z.enum(BUCKETS),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export type HeartbeatInput = {
	instanceId: string;
	version: string;
	flavor: string;
	roles: readonly string[];
	nodes: number;
	database: string;
	os: string;
	nodeVersion: string;
	voice: boolean;
	spaces: number;
	users30d: number;
	voiceMinutes1d: number;
};

export const bucket = (count: number): Bucket => {
	if (count <= 0) return "0";
	if (count <= 10) return "1-10";
	if (count <= 100) return "11-100";
	if (count <= 1_000) return "101-1k";
	if (count <= 10_000) return "1k-10k";

	return "10k+";
};

export const nodeMajor = (version: string): string => {
	return version.replace(/^v/, "").split(".")[0] ?? version;
};

export const buildHeartbeat = (input: HeartbeatInput): Heartbeat => {
	return {
		instanceId: input.instanceId,
		version: input.version,
		flavor: input.flavor,
		roles: [...input.roles].sort(),
		nodes: bucket(input.nodes),
		database: input.database,
		os: input.os,
		node: nodeMajor(input.nodeVersion),
		voice: input.voice,
		spaces: bucket(input.spaces),
		users30d: bucket(input.users30d),
		voiceMinutes1d: bucket(Math.round(input.voiceMinutes1d)),
	};
};

export const heartbeatDue = (lastSentAt: Date | null, now: Date): boolean => {
	return lastSentAt === null || now.getTime() - lastSentAt.getTime() >= HEARTBEAT_INTERVAL_MS;
};

export const sendHeartbeat = async (
	url: string,
	heartbeat: Heartbeat,
	options: { fetch?: typeof fetch; userAgent?: string } = {},
): Promise<boolean> => {
	const request = options.fetch ?? fetch;

	try {
		const response = await request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.userAgent ? { "user-agent": options.userAgent } : {}),
			},
			body: JSON.stringify(heartbeat),
			signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
		});

		return response.ok;
	} catch {
		return false;
	}
};
