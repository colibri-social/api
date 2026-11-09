import { describe, expect, it } from "vitest";
import type { EventMessage } from "../../appview/src/announce.js";
import { memoryBus } from "../../appview/src/bus.js";
import { sendOrder } from "./orders.js";

const log = { warn: () => {}, error: () => {} };

describe("sendOrder", () => {
	it("waits for the main node's answer to this order", async () => {
		const bus = memoryBus<EventMessage>("admin", log);

		bus.subscribe(({ message }) => {
			if (message.t === "clusterOrder") {
				bus.publish({
					t: "clusterOrderResult",
					result: { id: "other", ok: false, message: "not this one" },
				});
				bus.publish({
					t: "clusterOrderResult",
					result: { id: message.order.id, ok: true, message: "eu-2 is draining" },
				});
			}
		});

		await expect(sendOrder(bus, { kind: "resume", id: "o1", node: "eu-2" })).resolves.toEqual({
			id: "o1",
			ok: true,
			message: "eu-2 is draining",
		});
	});

	it("gives up when nobody answers", async () => {
		const bus = memoryBus<EventMessage>("admin", log);

		await expect(
			sendOrder(bus, { kind: "resume", id: "o2", node: "eu-2" }, 10),
		).resolves.toMatchObject({ ok: false });
	});
});
