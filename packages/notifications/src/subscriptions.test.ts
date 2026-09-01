import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotificationDeps } from "./deps.js";
import {
	listSubscriptionsForActor,
	registerFcm,
	registerWebPush,
	unregisterFcm,
	unregisterWebPush,
} from "./subscriptions.js";

const ACTOR = "did:plc:actor000000000000000000000";
const NOW = "2026-08-23T00:00:00.000Z";

let database: TestDatabase;
let deps: NotificationDeps;

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

describe("registerWebPush", () => {
	it("stores a new subscription", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});
		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("webpush");
	});

	it("updates rather than duplicates when the same endpoint registers again", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p2",
			auth: "a2",
		});

		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.p256dh).toBe("p2");
	});
});

describe("registerFcm", () => {
	it("updates rather than duplicates when the same token registers again", async () => {
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });

		const rows = await listSubscriptionsForActor(deps, ACTOR);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("fcm");
	});
});

describe("unregistering", () => {
	it("is idempotent for web push", async () => {
		await registerWebPush(deps, {
			actor: ACTOR,
			platform: "web",
			endpoint: "https://push.example/a",
			p256dh: "p1",
			auth: "a1",
		});

		await unregisterWebPush(deps, ACTOR, "https://push.example/a");
		await expect(unregisterWebPush(deps, ACTOR, "https://push.example/a")).resolves.toBeUndefined();
		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(0);
	});

	it("is idempotent for fcm", async () => {
		await registerFcm(deps, { actor: ACTOR, platform: "android", token: "token-1" });

		await unregisterFcm(deps, ACTOR, "token-1");
		await expect(unregisterFcm(deps, ACTOR, "token-1")).resolves.toBeUndefined();
		expect(await listSubscriptionsForActor(deps, ACTOR)).toHaveLength(0);
	});

	it("unregistering an endpoint that was never registered does nothing", async () => {
		await expect(
			unregisterWebPush(deps, ACTOR, "https://push.example/missing"),
		).resolves.toBeUndefined();
	});
});
