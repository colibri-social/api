import { availableParallelism } from "node:os";
import { z } from "zod";

export const DEFAULT_RTC_PORT = 40000;
export const DEFAULT_INITIAL_OUTGOING_BITRATE = 3_500_000;

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
	rtcPort: z.number().int().min(1).max(65535).default(DEFAULT_RTC_PORT),
	iceServers: z.array(iceServerSchema).default([]),
	initialAvailableOutgoingBitrate: z
		.number()
		.int()
		.positive()
		.default(DEFAULT_INITIAL_OUTGOING_BITRATE),
	participantsPerWorker: z.number().int().positive().default(20),
	roomGraceMs: z.number().int().nonnegative().default(30_000),
	speakingDebounceMs: z.number().int().nonnegative().default(1_000),
});

export type VoiceSfuConfigInput = z.input<typeof voiceSfuConfigSchema>;

export type VoiceSfuConfig = z.output<typeof voiceSfuConfigSchema>;

export function parseVoiceSfuConfig(input: VoiceSfuConfigInput = {}): VoiceSfuConfig {
	return voiceSfuConfigSchema.parse(input);
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
