import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createDeliveries,
	DELIVERY_BACKOFF_MS,
	DELIVERY_CUTOFF_MS,
	deliveryDelay,
} from "./deliveries.js";
import type { ForwardAnswer, Forwarder, ForwardRequest } from "./forward.js";
import { ForwardUnreachable } from "./forward.js";

const SELF = "did:web:market.example";
const HOME = "did:web:home.example";
const OTHER = "did:web:other.example";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const METHOD = "social.colibri.beta.federation.deliverNotification";

let database: TestDatabase;
let clock: number;

const answer = (status: number, body: unknown = {}): ForwardAnswer => {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: Buffer.from(JSON.stringify(body)),
	};
};

type SetupOptions = {
	forward?: Forwarder;
	declared?: string[];
	enabled?: boolean;
};

const setup = (options: SetupOptions = {}) => {
	const forward = vi.fn(options.forward ?? (async () => answer(200)));
	const dropped = vi.fn();

	const deliveries = createDeliveries({
		enabled: options.enabled ?? true,
		self: [SELF],
		database,
		declared: { list: async () => options.declared ?? [HOME, SELF] },
		endpointFor: async (appview) => `https://${appview.slice("did:web:".length)}`,
		forward,
		now: () => new Date(clock),
		onDropped: dropped,
	});

	return { deliveries, forward, dropped };
};

const queued = () => {
	return database.db.select().from(database.tables.federationDeliveries);
};

beforeEach(async () => {
	database = await openTestDatabase();
	clock = Date.parse("2026-11-27T12:00:00.000Z");
});

afterEach(async () => {
	await database.destroy();
});

describe("deliveryDelay", () => {
	it("backs off up to an hour", () => {
		expect([1, 2, 3, 4, 5, 9].map(deliveryDelay)).toEqual([
			...DELIVERY_BACKOFF_MS,
			DELIVERY_BACKOFF_MS.at(-1),
		]);
	});
});

describe("createDeliveries", () => {
	it("queues one delivery per AppView the recipient declared, leaving out this one", async () => {
		const { deliveries } = setup({ declared: [HOME, SELF, OTHER] });

		await expect(
			deliveries.enqueue(USER, METHOD, {
				recipient: USER,
			}),
		).resolves.toBe(2);

		expect((await queued()).map((row) => row.target).sort()).toEqual([HOME, OTHER]);
	});

	it("queues nothing when federation is off or the recipient only uses this AppView", async () => {
		const off = setup({
			enabled: false,
		});

		await expect(off.deliveries.enqueue(USER, METHOD, {})).resolves.toBe(0);

		const alone = setup({
			declared: [SELF],
		});

		await expect(alone.deliveries.enqueue(USER, METHOD, {})).resolves.toBe(0);
		expect(await queued()).toEqual([]);
	});

	it("posts the body with service auth and removes it once delivered", async () => {
		const { deliveries, forward } = setup();

		await deliveries.enqueue(USER, METHOD, { recipient: USER });
		await deliveries.run();

		const [target, request] = forward.mock.calls[0] as [unknown, ForwardRequest];

		expect(target).toEqual({
			managingApp: HOME,
			endpoint: "https://home.example",
		});

		expect(request).toMatchObject({
			method: "POST",
			path: `/xrpc/${METHOD}`,
			serviceAuth: true,
			actingFor: undefined,
		});

		expect(JSON.parse(String(request.body))).toEqual({ recipient: USER });
		expect(await queued()).toEqual([]);
	});

	it("tries again later when the AppView is down or busy", async () => {
		const { deliveries, forward } = setup({
			forward: async () => {
				throw new ForwardUnreachable(HOME);
			},
		});

		await deliveries.enqueue(USER, METHOD, {});
		await deliveries.run();

		const [row] = await queued();

		expect(row?.attempts).toBe(1);
		expect(Date.parse(row?.nextAttemptAt ?? "")).toBe(clock + deliveryDelay(1));

		await deliveries.run();
		expect(forward).toHaveBeenCalledTimes(1);

		forward.mockImplementation(async () => answer(503));
		clock += deliveryDelay(1);
		await deliveries.run();
		expect((await queued())[0]?.attempts).toBe(2);
	});

	it("drops a delivery the AppView refuses for good", async () => {
		const { deliveries, dropped } = setup({
			forward: async () => answer(403, { error: "NotDeclared" }),
		});

		await deliveries.enqueue(USER, METHOD, {});
		await deliveries.run();

		expect(await queued()).toEqual([]);
		expect(dropped).toHaveBeenCalledWith(HOME, METHOD, "NotDeclared");
	});

	it("gives up after a day", async () => {
		const { deliveries, dropped } = setup({ forward: async () => answer(500) });

		await deliveries.enqueue(USER, METHOD, {});
		clock += DELIVERY_CUTOFF_MS - 1_000;
		await deliveries.run();

		expect(await queued()).toEqual([]);
		expect(dropped).toHaveBeenCalledWith(HOME, METHOD, "expired");
	});
});
