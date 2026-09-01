import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import {
	buildPayload,
	type DeliveryOutcome,
	deliverNotification,
	nullPushSender,
	type PushSender,
} from "./push.js";
import { listSubscriptionsForActor, registerFcm, registerWebPush } from "./subscriptions.js";

const ACTOR = "did:plc:actor000000000000000000000";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let deps: NotificationDeps;

const fakeSender = (outcome: DeliveryOutcome): PushSender => ({
	send: async () => outcome,
});

beforeEach(async () => {
	database = await openTestDatabase();
	deps = {
		db: database.db,
		tables: database.tables,
		now: () => NOW,
		mayRead: async () => true,
	};
});

afterEach(async () => {
	await database.destroy();
});

const notification = {
	recipient: ACTOR,
	kind: "message",
	mentionRole: null,
	space: "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1",
	author: "did:plc:author00000000000000000000",
	messageRkey: "3lkmsg1",
};

describe("deliverNotification", () => {
	it("prunes a subscription the provider reports as permanently gone", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});

		await deliverNotification(deps, { webpush: fakeSender("gone") }, notification, { text: "hi" });

		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(0);
	});

	it("keeps a subscription after a transient failure", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});

		await deliverNotification(deps, { webpush: fakeSender("failed") }, notification, {
			text: "hi",
		});

		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(1);
	});

	it("prunes only the fcm subscription reported gone, keeping the web push one", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });

		await deliverNotification(
			deps,
			{ webpush: fakeSender("delivered"), fcm: fakeSender("gone") },
			notification,
			{ text: "hi" },
		);

		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("webpush");
	});

	it("never throws when no sender is configured for a subscription's provider", async () => {
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });
		await expect(
			deliverNotification(deps, {}, notification, { text: "hi" }),
		).resolves.toBeUndefined();
		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(1);
	});

	it("is a no-op when the recipient has no subscriptions", async () => {
		await expect(
			deliverNotification(deps, { webpush: nullPushSender }, notification, { text: "hi" }),
		).resolves.toBeUndefined();
	});
});

describe("buildPayload", () => {
	it("carries the routing hints the web and Android clients read", () => {
		const payload = buildPayload(notification, { text: "hi" });

		expect(payload.data).toEqual({
			channel: notification.space,
			channelUri: notification.space,
			messageAuthor: notification.author,
			messageRkey: notification.messageRkey,
			messageUri: `${notification.space}/${notification.author}/social.colibri.beta.message/${notification.messageRkey}`,
			deepLink:
				"social.colibri:/channel/did:plc:community/social.colibri.beta.channel.text/3lkchannel1",
		});
	});

	it("leaves the routing hints off when the space ref is malformed", () => {
		const payload = buildPayload({ ...notification, space: "not-a-space-ref" }, { text: "hi" });

		expect(payload.data.messageUri).toBeUndefined();
		expect(payload.data.deepLink).toBeUndefined();
		expect(payload.data.channel).toBe("not-a-space-ref");
	});
});
