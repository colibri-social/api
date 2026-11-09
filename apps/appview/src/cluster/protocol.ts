import { z } from "zod";

export const CONTROL_PATH = "/cluster/control";

export const JOIN_PATH = "/cluster/join";

export const CONFIG_PATH = "/cluster/config";

export const NODE_ID_HEADER = "x-colibri-node";

export const NODE_SECRET_HEADER = "x-colibri-node-secret";

export type ParkMode = "maintenance" | "retire";

export const nodeFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("drained"), mode: z.enum(["maintenance", "retire"]) }),
]);

export type NodeFrame = z.infer<typeof nodeFrameSchema>;

export const mainFrameSchema = z.discriminatedUnion("t", [
	z.object({ t: z.literal("welcome"), mainNodeId: z.string() }),
	z.object({
		t: z.literal("drain"),
		mode: z.enum(["maintenance", "retire"]),
		graceMinutes: z.number().nonnegative().optional(),
	}),
	z.object({ t: z.literal("resume") }),
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
