import type { PushPlatform, Schema } from "@colibri-social/appview-db";
import { and, eq } from "drizzle-orm";
import type { NotificationDeps } from "./deps.js";
import { nextId } from "./id.js";

export type PushSubscriptionRow = Schema["pushSubscriptions"]["$inferSelect"];

export type RegisterWebPushInput = {
	actor: string;
	platform: PushPlatform;
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type RegisterFcmInput = {
	actor: string;
	platform: PushPlatform;
	token: string;
};

export const registerWebPush = async (
	deps: NotificationDeps,
	input: RegisterWebPushInput,
): Promise<void> => {
	const [existing] = await deps.db
		.select({ id: deps.tables.pushSubscriptions.id })
		.from(deps.tables.pushSubscriptions)
		.where(
			and(
				eq(deps.tables.pushSubscriptions.provider, "webpush"),
				eq(deps.tables.pushSubscriptions.endpoint, input.endpoint),
			),
		)
		.limit(1);

	if (existing) {
		await deps.db
			.update(deps.tables.pushSubscriptions)
			.set({
				actor: input.actor,
				platform: input.platform,
				p256dh: input.p256dh,
				auth: input.auth,
			})
			.where(eq(deps.tables.pushSubscriptions.id, existing.id));
		return;
	}

	await deps.db.insert(deps.tables.pushSubscriptions).values({
		id: nextId(),
		actor: input.actor,
		provider: "webpush",
		platform: input.platform,
		endpoint: input.endpoint,
		p256dh: input.p256dh,
		auth: input.auth,
		token: null,
		createdAt: deps.now(),
	});
};

export const registerFcm = async (
	deps: NotificationDeps,
	input: RegisterFcmInput,
): Promise<void> => {
	const [existing] = await deps.db
		.select({ id: deps.tables.pushSubscriptions.id })
		.from(deps.tables.pushSubscriptions)
		.where(
			and(
				eq(deps.tables.pushSubscriptions.provider, "fcm"),
				eq(deps.tables.pushSubscriptions.token, input.token),
			),
		)
		.limit(1);

	if (existing) {
		await deps.db
			.update(deps.tables.pushSubscriptions)
			.set({ actor: input.actor, platform: input.platform })
			.where(eq(deps.tables.pushSubscriptions.id, existing.id));
		return;
	}

	await deps.db.insert(deps.tables.pushSubscriptions).values({
		id: nextId(),
		actor: input.actor,
		provider: "fcm",
		platform: input.platform,
		endpoint: null,
		p256dh: null,
		auth: null,
		token: input.token,
		createdAt: deps.now(),
	});
};

export const unregisterWebPush = async (
	deps: NotificationDeps,
	actor: string,
	endpoint: string,
): Promise<void> => {
	await deps.db
		.delete(deps.tables.pushSubscriptions)
		.where(
			and(
				eq(deps.tables.pushSubscriptions.actor, actor),
				eq(deps.tables.pushSubscriptions.provider, "webpush"),
				eq(deps.tables.pushSubscriptions.endpoint, endpoint),
			),
		);
};

export const unregisterFcm = async (
	deps: NotificationDeps,
	actor: string,
	token: string,
): Promise<void> => {
	await deps.db
		.delete(deps.tables.pushSubscriptions)
		.where(
			and(
				eq(deps.tables.pushSubscriptions.actor, actor),
				eq(deps.tables.pushSubscriptions.provider, "fcm"),
				eq(deps.tables.pushSubscriptions.token, token),
			),
		);
};

export const listSubscriptionsForActor = async (
	deps: NotificationDeps,
	actor: string,
): Promise<PushSubscriptionRow[]> =>
	deps.db
		.select()
		.from(deps.tables.pushSubscriptions)
		.where(eq(deps.tables.pushSubscriptions.actor, actor));

export const removeSubscriptionById = async (deps: NotificationDeps, id: string): Promise<void> => {
	await deps.db
		.delete(deps.tables.pushSubscriptions)
		.where(eq(deps.tables.pushSubscriptions.id, id));
};
