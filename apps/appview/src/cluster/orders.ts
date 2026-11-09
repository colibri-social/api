import type { MainFrame, ParkMode } from "./protocol.js";
import type { Registry } from "./registry.js";

export type ClusterOrder =
	| {
			kind: "shutdown";
			id: string;
			node: string;
			mode: ParkMode;
			graceMinutes?: number;
			force?: boolean;
	  }
	| { kind: "resume"; id: string; node: string };

export type OrderResult = {
	id: string;
	ok: boolean;
	message: string;
};

export type OrderDeps = {
	registry: Registry;
	self: string;
	send: (nodeId: string, frame: MainFrame) => boolean;
};

export const parkedState = (mode: ParkMode): "maintenance" | "retired" => {
	return mode === "retire" ? "retired" : "maintenance";
};

const done = (order: ClusterOrder, message: string): OrderResult => {
	return { id: order.id, ok: true, message };
};

const refused = (order: ClusterOrder, message: string): OrderResult => {
	return { id: order.id, ok: false, message };
};

const shutdown = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "shutdown" }>,
): Promise<OrderResult> => {
	const target = await deps.registry.node(order.node);

	if (!target) {
		return refused(order, `no node is called ${order.node}`);
	}

	if (target.state === "retired") {
		return refused(order, `${order.node} is already retired`);
	}

	if (target.state === parkedState(order.mode)) {
		return done(order, `${order.node} is already in ${target.state}`);
	}

	if (target.id === deps.self) {
		return refused(
			order,
			`${order.node} is the main node. Hand writes to the failover node before shutting it down`,
		);
	}

	if (!order.force) {
		const decision = await deps.registry.mayLeave(order.node);

		if (!decision.allowed) {
			return refused(order, `${decision.reason}. Pass --force to shut it down anyway`);
		}
	}

	const sent = deps.send(order.node, {
		t: "drain",
		mode: order.mode,
		...(order.graceMinutes === undefined ? {} : { graceMinutes: order.graceMinutes }),
	});

	if (sent) {
		await deps.registry.setState(order.node, "draining");

		return done(order, `${order.node} is draining`);
	}

	if (order.force) {
		await deps.registry.setState(order.node, parkedState(order.mode), null);

		return done(
			order,
			`${order.node} is not connected and is now marked ${parkedState(order.mode)}`,
		);
	}

	return refused(order, `${order.node} is not connected. Pass --force to mark it without draining`);
};

const resume = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "resume" }>,
): Promise<OrderResult> => {
	const target = await deps.registry.node(order.node);

	if (!target) {
		return refused(order, `no node is called ${order.node}`);
	}

	if (target.state === "retired") {
		return refused(order, `${order.node} is retired. Add it again with colibri-admin node add`);
	}

	if (target.state !== "maintenance") {
		return done(order, `${order.node} is not in maintenance`);
	}

	await deps.registry.setState(order.node, "active", null);

	const sent = deps.send(order.node, { t: "resume" });

	return done(
		order,
		sent
			? `${order.node} is restarting`
			: `${order.node} is marked active and rejoins when it starts`,
	);
};

export const handleOrder = (deps: OrderDeps, order: ClusterOrder): Promise<OrderResult> => {
	return order.kind === "shutdown" ? shutdown(deps, order) : resume(deps, order);
};
