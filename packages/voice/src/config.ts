import { availableParallelism } from "node:os";
import { z } from "zod";

export const DEFAULT_RTC_MIN_PORT = 40000;
export const DEFAULT_RTC_MAX_PORT = 40100;

export const iceServerSchema = z.object({
	urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
	username: z.string().min(1).optional(),
	credential: z.string().min(1).optional(),
});

export type IceServer = z.infer<typeof iceServerSchema>;

export const voiceSfuConfigSchema = z.object({
	workerCount: z
		.number()
		.int()
		.positive()
		.optional()
		.default(() => availableParallelism()),
	listenIp: z.string().min(1).default("0.0.0.0"),
	announcedIp: z.string().min(1).optional(),
	rtcMinPort: z.number().int().min(0).max(65535).default(DEFAULT_RTC_MIN_PORT),
	rtcMaxPort: z.number().int().min(0).max(65535).default(DEFAULT_RTC_MAX_PORT),
	iceServers: z.array(iceServerSchema).default([]),
	roomGraceMs: z.number().int().nonnegative().default(30_000),
	speakingDebounceMs: z.number().int().nonnegative().default(1_000),
});

export type VoiceSfuConfigInput = z.input<typeof voiceSfuConfigSchema>;

export type VoiceSfuConfig = z.output<typeof voiceSfuConfigSchema>;

function normalizePortRange(
	rtcMinPort: number,
	rtcMaxPort: number,
): { rtcMinPort: number; rtcMaxPort: number } {
	if (rtcMinPort <= rtcMaxPort) {
		return { rtcMinPort, rtcMaxPort };
	}
	return { rtcMinPort: DEFAULT_RTC_MIN_PORT, rtcMaxPort: DEFAULT_RTC_MAX_PORT };
}

export function parseVoiceSfuConfig(input: VoiceSfuConfigInput = {}): VoiceSfuConfig {
	const parsed = voiceSfuConfigSchema.parse(input);
	return { ...parsed, ...normalizePortRange(parsed.rtcMinPort, parsed.rtcMaxPort) };
}

export function parseIceServers(raw: string | undefined): IceServer[] {
	if (raw === undefined || raw.trim() === "") {
		return [];
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("SFU_ICE_SERVERS is not valid JSON");
	}

	const result = z.array(iceServerSchema).safeParse(value);
	if (!result.success) {
		throw new Error(`SFU_ICE_SERVERS is invalid: ${result.error.message}`);
	}
	return result.data;
}

function optionalString(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value : undefined;
}

function optionalPositiveInt(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function voiceSfuConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
): VoiceSfuConfig {
	return parseVoiceSfuConfig({
		workerCount: optionalPositiveInt(env.SFU_WORKER_COUNT),
		listenIp: optionalString(env.SFU_LISTEN_IP) ?? "0.0.0.0",
		announcedIp: optionalString(env.SFU_ANNOUNCED_IP),
		rtcMinPort: optionalPositiveInt(env.SFU_RTC_MIN_PORT) ?? DEFAULT_RTC_MIN_PORT,
		rtcMaxPort: optionalPositiveInt(env.SFU_RTC_MAX_PORT) ?? DEFAULT_RTC_MAX_PORT,
		iceServers: parseIceServers(env.SFU_ICE_SERVERS),
	});
}
