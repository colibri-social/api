import { z } from "zod";

export const CONTROL_PATH = "/cluster/control";

export const JOIN_PATH = "/cluster/join";

export const CONFIG_PATH = "/cluster/config";

export const ALIVE_PATH = "/cluster/alive";

export const NODE_ID_HEADER = "x-colibri-node";

export const NODE_SECRET_HEADER = "x-colibri-node-secret";

export const CONTROL_PING_MS = 15_000;

export const CLOSE_REPLACED = 4000;

export const CLOSE_MAIN_RELEASED = 4001;

export const linkErrorCode = (error: unknown): string => {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;

		return typeof code === "string" ? code : error.name;
	}

	return "Unknown";
};

export type ParkMode = "maintenance" | "retire";

export type DrainMode = ParkMode | "update";

const drainModeSchema = z.enum(["maintenance", "retire", "update"]);

export const nodeFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("drained"), mode: drainModeSchema }),
]);

export type NodeFrame = z.infer<typeof nodeFrameSchema>;

export const mainFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("welcome"), mainNodeId: z.string() }),
	z.object({
		t: z.literal("drain"),
		mode: drainModeSchema,
		graceMinutes: z.number().nonnegative().optional(),
	}),
	z.object({ t: z.literal("resume") }),
	z.object({ t: z.literal("takeMain") }),
]);

export type MainFrame = z.infer<typeof mainFrameSchema>;

export const joinRequestSchema = z.object({
	token: z.string().min(1),
	publicUrl: z.url(),
	tailnetUrl: z.url(),
	announcedIp: z.string().optional(),
	version: z.string(),
});

export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const joinResponseSchema = z.object({
	id: z.string(),
	secret: z.string(),
});

export type JoinResponse = z.infer<typeof joinResponseSchema>;

export const configResponseSchema = z.object({
	values: z.record(z.string(), z.string()),
});

export const aliveSchema = z.object({
	node: z.string(),
	main: z.boolean(),
	draining: z.boolean(),
	primaryDownSince: z.number().nullable().optional(),
});

export type Alive = z.infer<typeof aliveSchema>;

export const notMainSchema = z.object({
	error: z.literal("NotMain"),
	main: z.string().nullable(),
});

export const parseFrame = <T>(schema: z.ZodType<T>, raw: string): T | null => {
	try {
		const result = schema.safeParse(JSON.parse(raw));

		return result.success ? result.data : null;
	} catch {
		return null;
	}
};
