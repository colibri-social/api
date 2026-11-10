import type { NodeRole } from "@colibri-social/appview-db";
import type { AnsibleRunner, Playbook, PlaybookResult } from "./ansible.js";
import type { MainFrame, ParkMode } from "./protocol.js";
import type { ProvisionTarget } from "./provisioning.js";
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
	| { kind: "resume"; id: string; node: string }
	| {
			kind: "provision";
			id: string;
			node: string;
			ip: string;
			region: string;
			roles: NodeRole[];
			publicUrl: string;
			joinToken: string;
			workers?: number;
	  }
	| { kind: "recover"; id: string; node: string }
	| { kind: "deprovision"; id: string; node: string; force?: boolean };

export type OrderResult = {
	id: string;
	ok: boolean;
	message: string;
};

export type OrderDeps = {
	registry: Registry;
	self: string;
	send: (nodeId: string, frame: MainFrame) => boolean;
	ansible?: AnsibleRunner;
	provisioning?: {
		missing: (roles: readonly NodeRole[]) => string[];
		vars: (target: ProvisionTarget) => Promise<Record<string, unknown>>;
		removeNode: (id: string) => Promise<void>;
	};
	background?: (work: Promise<unknown>) => void;
};

const tailOf = (result: PlaybookResult): string => {
	return result.tail.slice(-5).join("\n");
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

const runInBackground = (
	deps: OrderDeps,
	ansible: AnsibleRunner,
	playbook: Playbook,
	host: string,
	vars: Record<string, unknown>,
): void => {
	const work = ansible.run({ playbook, host, vars });

	if (deps.background) {
		deps.background(work);
	} else {
		void work.catch(() => {});
	}
};

const provision = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "provision" }>,
): Promise<OrderResult> => {
	const { ansible, provisioning } = deps;

	if (!ansible || !provisioning) {
		return refused(order, "this main node can't run Ansible");
	}

	const missing = provisioning.missing(order.roles);

	if (missing.length > 0) {
		return refused(order, `the main node is missing ${missing.join(", ")}`);
	}

	const vars = await provisioning.vars({
		node: order.node,
		region: order.region,
		roles: order.roles,
		publicUrl: order.publicUrl,
		joinToken: order.joinToken,
		...(order.workers === undefined ? {} : { workers: order.workers }),
	});

	runInBackground(deps, ansible, "bootstrap", order.ip, vars);

	return done(order, `provisioning ${order.node} at ${order.ip}. Follow it with node list`);
};

const tailnetHost = async (deps: OrderDeps, node: string): Promise<string | null> => {
	const row = await deps.registry.node(node);

	return row ? new URL(row.tailnetUrl).hostname : null;
};

const recover = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "recover" }>,
): Promise<OrderResult> => {
	const host = await tailnetHost(deps, order.node);

	if (!host) {
		return refused(order, `no node is called ${order.node}`);
	}

	if (!deps.ansible) {
		return refused(order, "this main node can't run Ansible");
	}

	runInBackground(deps, deps.ansible, "recover", host, {});

	return done(order, `restarting the stack on ${order.node}`);
};

const deprovision = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "deprovision" }>,
): Promise<OrderResult> => {
	const target = await deps.registry.node(order.node);

	if (!target) {
		return refused(order, `no node is called ${order.node}`);
	}

	if (target.id === deps.self) {
		return refused(order, `${order.node} is the main node and can't be removed`);
	}

	if (target.state !== "retired" && !order.force) {
		return refused(
			order,
			`${order.node} is ${target.state}. Retire it with colibri-admin node shutdown ${order.node} --retire first, or pass --force`,
		);
	}

	if (!deps.ansible || !deps.provisioning) {
		return refused(order, "this main node can't run Ansible");
	}

	const result = await deps.ansible.run({
		playbook: "remove",
		host: new URL(target.tailnetUrl).hostname,
		vars: {},
	});

	if (!result.ok && !order.force) {
		return refused(
			order,
			`removing the stack on ${order.node} failed. Pass --force to forget it anyway\n${tailOf(result)}`,
		);
	}

	await deps.provisioning.removeNode(order.node);

	return done(order, `removed ${order.node}`);
};

export const ORDER_TIMEOUTS_MS: Record<ClusterOrder["kind"], number> = {
	shutdown: 30_000,
	resume: 30_000,
	provision: 30_000,
	recover: 30_000,
	deprovision: 10 * 60_000,
};

export const handleOrder = (deps: OrderDeps, order: ClusterOrder): Promise<OrderResult> => {
	switch (order.kind) {
		case "shutdown":
			return shutdown(deps, order);
		case "resume":
			return resume(deps, order);
		case "provision":
			return provision(deps, order);
		case "recover":
			return recover(deps, order);
		case "deprovision":
			return deprovision(deps, order);
	}
};
