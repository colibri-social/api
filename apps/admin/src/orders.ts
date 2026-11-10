import {
	type ClusterOrder,
	type EventBus,
	type EventMessage,
	ORDER_TIMEOUTS_MS,
	type OrderResult,
	postgresBus,
} from "@colibri-social/appview/cluster";
import type { Database } from "@colibri-social/appview-db";

export const ORDER_TIMEOUT_MS = 30_000;

export const sendOrder = (
	bus: Pick<EventBus<EventMessage>, "publish" | "subscribe">,
	order: ClusterOrder,
	timeoutMs = ORDER_TIMEOUTS_MS[order.kind] ?? ORDER_TIMEOUT_MS,
): Promise<OrderResult> => {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			stop();
			resolve({
				id: order.id,
				ok: false,
				message: "the main node did not answer. Check that it is running",
			});
		}, timeoutMs);
		const stop = bus.subscribe(({ message }) => {
			if (message.t === "clusterOrderResult" && message.result.id === order.id) {
				clearTimeout(timer);
				stop();
				resolve(message.result);
			}
		});

		bus.publish({ t: "clusterOrder", order });
	});
};

export const openOrderBus = async (url: string, database: Database) => {
	if (database.dialect !== "postgres") {
		return null;
	}

	return postgresBus<EventMessage>({
		url,
		nodeId: `admin-${process.pid}`,
		database,
		log: { warn: () => {}, error: () => {} },
	});
};
