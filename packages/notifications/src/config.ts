import { z } from "zod";

export const vapidConfigSchema = z.object({
	publicKey: z.string().min(1),
	privateKey: z.string().min(1),
	subject: z.string().min(1).default("mailto:admin@colibri.social"),
});

export type VapidConfig = z.infer<typeof vapidConfigSchema>;

export const fcmConfigSchema = z.object({
	projectId: z.string().min(1),
	clientEmail: z.string().min(1),
	privateKey: z.string().min(1),
});

export type FcmConfig = z.infer<typeof fcmConfigSchema>;

export const notificationsConfigSchema = z.object({
	vapid: vapidConfigSchema.optional(),
	fcm: fcmConfigSchema.optional(),
});

export type NotificationsConfig = z.infer<typeof notificationsConfigSchema>;

export type PushProviderName = "webpush" | "fcm";

export const configuredProviders = (config: NotificationsConfig): PushProviderName[] => {
	const providers: PushProviderName[] = [];
	if (config.vapid) providers.push("webpush");
	if (config.fcm) providers.push("fcm");
	return providers;
};

const fcmServiceAccountSchema = z.object({
	project_id: z.string().min(1),
	client_email: z.string().min(1),
	private_key: z.string().min(1),
});

export const parseFcmServiceAccountJson = (raw: string): FcmConfig => {
	const parsed = fcmServiceAccountSchema.parse(JSON.parse(raw));
	return fcmConfigSchema.parse({
		projectId: parsed.project_id,
		clientEmail: parsed.client_email,
		privateKey: parsed.private_key,
	});
};
