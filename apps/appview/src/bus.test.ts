import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BusDelivery, type EventBus, memoryBus, postgresBus } from "./bus.js";

type Message = { n: number; text?: string };

const log = { warn: vi.fn(), error: vi.fn() };

const collect = (bus: EventBus<Message>) => {
	const received: BusDelivery<Message>[] = [];

	bus.subscribe((delivery) => {
		received.push(delivery);
	});

	return received;
};

describe("memoryBus", () => {
	it("delivers locally, in publish order, even when a handler is slow", async () => {
		const bus = memoryBus<Message>("node-a", log);
		const order: number[] = [];

		bus.subscribe(async ({ message }) => {
			if (message.n === 1) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			order.push(message.n);
		});

		bus.publish({ n: 1 });
		bus.publish({ n: 2 });

		await vi.waitFor(() => expect(order).toEqual([1, 2]));
	});

	it("marks deliveries as local with no WAL position", async () => {
		const bus = memoryBus<Message>("node-a", log);
		const received = collect(bus);

		bus.publish({ n: 1 });

		await vi.waitFor(() =>
			expect(received).toEqual([{ message: { n: 1 }, origin: "node-a", lsn: null, local: true }]),
		);
	});

	it("keeps delivering after a handler throws", async () => {
		const bus = memoryBus<Message>("node-a", log);
		const received = collect(bus);

		bus.subscribe(() => {
			throw new Error("boom");
		});

		bus.publish({ n: 1 });
		bus.publish({ n: 2 });

		await vi.waitFor(() => expect(received.map(({ message }) => message.n)).toEqual([1, 2]));
	});
});

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("postgresBus", () => {
	let database: TestDatabase;
	const buses: EventBus<Message>[] = [];

	const busFor = async (nodeId: string) => {
		const bus = await postgresBus<Message>({
			url: database.url,
			nodeId,
			database,
			log,
		});

		buses.push(bus);

		return bus;
	};

	beforeEach(async () => {
		database = await openTestDatabase();
	});

	afterEach(async () => {
		await Promise.all(buses.splice(0).map((bus) => bus.close()));
		await database.destroy();
	});

	it("reaches other nodes once, with the primary's WAL position", async () => {
		const a = await busFor("node-a");
		const b = await busFor("node-b");
		const onA = collect(a);
		const onB = collect(b);

		a.publish({ n: 1 });

		await vi.waitFor(() => expect(onB).toHaveLength(1));

		expect(onB[0]).toMatchObject({ message: { n: 1 }, origin: "node-a", local: false });
		expect(onB[0]?.lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);

		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(onA).toEqual([{ message: { n: 1 }, origin: "node-a", lsn: null, local: true }]);
	});

	it("keeps the publish order across nodes", async () => {
		const a = await busFor("node-a");
		const b = await busFor("node-b");
		const onB = collect(b);

		for (let n = 1; n <= 20; n += 1) {
			a.publish({ n });
		}

		await vi.waitFor(() => expect(onB).toHaveLength(20));

		expect(onB.map(({ message }) => message.n)).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 1),
		);
	});

	it("carries a payload over the notify limit through the payload table", async () => {
		const a = await busFor("node-a");
		const b = await busFor("node-b");
		const onB = collect(b);
		const text = "x".repeat(20_000);

		a.publish({ n: 1, text });

		await vi.waitFor(() => expect(onB).toHaveLength(1));

		expect(onB[0]?.message.text).toBe(text);

		const stored = await database.db.select().from(database.tables.eventPayloads);

		expect(stored).toHaveLength(1);
	});
});
