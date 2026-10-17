import {
	createReadFanout,
	createSenders,
	type DeliveryOptions,
	deliverRead,
	type ReadFanout,
	resolveReadTarget,
	type Senders,
} from "@colibri-social/notifications";
import type { AppContext } from "./context.js";
import { notificationDeps } from "./notification-deps.js";

export const MARK_READ_NSID = "social.colibri.beta.notification.markReadFromNotification";

export type PushDelivery = {
	enabled: boolean;
	senders: Senders;
	options: DeliveryOptions;
	readMoved: (did: string, community: string, cursors: readonly ReadCursorMove[]) => void;
	flush: () => Promise<void>;
	close: () => void;
};

export type ReadCursorMove = { channel: string; cursor: string };

export const markReadUrl = (publicUrl: string): string =>
	new URL(`/xrpc/${MARK_READ_NSID}`, publicUrl).toString();

const deliveries = new WeakMap<object, PushDelivery>();

const createPushDelivery = (ctx: AppContext): PushDelivery => {
	const enabled = ctx.config.pushProviders.length > 0;
	const senders: Senders = enabled ? createSenders(ctx.config.notifications) : {};
	const options: DeliveryOptions = ctx.config.PUSH_ACTION_SECRET
		? {
				readAction: {
					url: markReadUrl(ctx.config.PUBLIC_URL),
					secret: ctx.config.PUSH_ACTION_SECRET,
				},
			}
		: {};
	const deps = notificationDeps(ctx);
	const fanout: ReadFanout = createReadFanout({
		deliver: async (did, target) => {
			await deliverRead(deps, senders, did, target);
		},
		onError: (error) => ctx.log.warn({ error }, "push.readFanoutFailed"),
	});

	const readMoved: PushDelivery["readMoved"] = (did, community, cursors) => {
		if (!enabled || cursors.length === 0) return;
		void Promise.all(
			cursors.map(async ({ channel, cursor }) => {
				const target = await resolveReadTarget(deps, community, channel);
				if (target) fanout.schedule(did, { ...target, through: cursor });
			}),
		).catch((error: unknown) => ctx.log.warn({ error }, "push.readFanoutFailed"));
	};

	return { enabled, senders, options, readMoved, flush: fanout.flush, close: fanout.close };
};

export const pushDelivery = (ctx: AppContext): PushDelivery => {
	const existing = deliveries.get(ctx);
	if (existing) return existing;
	const created = createPushDelivery(ctx);
	deliveries.set(ctx, created);
	return created;
};
