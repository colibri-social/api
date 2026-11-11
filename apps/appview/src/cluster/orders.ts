import type { NodeRole } from "@colibri-social/appview-db";
import type { AnsibleRunner, Playbook, PlaybookResult } from "./ansible.js";
import type { MainFrame, ParkMode } from "./protocol.js";
import type { ProvisionTarget } from "./provisioning.js";
import type { NodeRow, Registry } from "./registry.js";

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
	| { kind: "deprovision"; id: string; node: string; force?: boolean }
	| { kind: "deployStatus"; id: string; node: string }
	| { kind: "deployMonitoring"; id: string; node: string };

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
	dns?: {
		put: (node: string, host: string, ip: string) => Promise<void>;
		remove: (host: string) => Promise<boolean>;
		alias?: (host: string, target: string) => Promise<void>;
	};
	monitoring?: {
		vars: () => Record<string, unknown> | null;
		remoteWriteUrl: () => string | null;
		setRemoteWriteUrl: (url: string) => Promise<void>;
		alloyVars: (node: NodeRow, self: boolean, url: string) => Record<string, unknown>;
	};
	status?: {
		vars: (node: { id: string; self: boolean }) => Record<string, unknown> | null;
		host: string | null;
	};
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

const hostOf = (url: string): string => {
	return new URL(url).hostname;
};

const startAlloy = async (
	deps: OrderDeps,
	ansible: AnsibleRunner,
	node: NodeRow,
	url: string,
): Promise<PlaybookResult | null> => {
	if (!deps.monitoring) {
		return null;
	}

	return ansible.run({
		playbook: "alloy",
		host: hostOf(node.tailnetUrl),
		vars: deps.monitoring.alloyVars(node, node.id === deps.self, url),
	});
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

	if (deps.dns) {
		const host = new URL(order.publicUrl).hostname;
		const failure = await deps.dns.put(order.node, host, order.ip).then(
			() => null,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		if (failure) {
			return refused(order, `setting the DNS record for ${host} failed: ${failure}`);
		}
	}

	const remoteWrite = deps.monitoring?.remoteWriteUrl() ?? null;

	if (remoteWrite) {
		const work = ansible
			.run({ playbook: "bootstrap", host: order.ip, vars })
			.then(async (result) => {
				const node = result.ok ? await deps.registry.node(order.node) : null;

				return node ? ((await startAlloy(deps, ansible, node, remoteWrite)) ?? result) : result;
			});

		if (deps.background) {
			deps.background(work);
		} else {
			void work.catch(() => {});
		}

		return done(order, `provisioning ${order.node} at ${order.ip}. Follow it with node list`);
	}

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

	const host = new URL(target.publicUrl).hostname;
	const dnsFailure = deps.dns
		? await deps.dns.remove(host).then(
				() => null,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			)
		: null;

	if (dnsFailure) {
		return done(
			order,
			`removed ${order.node}, but its DNS record for ${host} is still there: ${dnsFailure}`,
		);
	}

	return done(order, `removed ${order.node}`);
};

const deployStatus = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "deployStatus" }>,
): Promise<OrderResult> => {
	const target = await deps.registry.node(order.node);

	if (!target) {
		return refused(order, `no node is called ${order.node}`);
	}

	if (!deps.ansible) {
		return refused(order, "this main node can't run Ansible");
	}

	const vars = deps.status?.vars({ id: target.id, self: target.id === deps.self });

	if (!vars || !deps.status?.host) {
		return refused(order, "the main node is missing KUMA_PUBLIC_URL");
	}

	const statusHost = deps.status.host;

	if (deps.dns?.alias) {
		const nodeHost = new URL(target.publicUrl).hostname;
		const failure = await deps.dns.alias(statusHost, nodeHost).then(
			() => null,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		if (failure) {
			return refused(order, `pointing ${statusHost} at ${nodeHost} failed: ${failure}`);
		}
	}

	runInBackground(deps, deps.ansible, "uptime-kuma", new URL(target.tailnetUrl).hostname, vars);

	return done(
		order,
		`deploying Uptime Kuma to ${order.node}. Set KUMA_URL to http://${new URL(target.tailnetUrl).hostname}:3001`,
	);
};

const deployMonitoring = async (
	deps: OrderDeps,
	order: Extract<ClusterOrder, { kind: "deployMonitoring" }>,
): Promise<OrderResult> => {
	const target = await deps.registry.node(order.node);

	if (!target) {
		return refused(order, `no node is called ${order.node}`);
	}

	const { ansible, monitoring } = deps;

	if (!ansible || !monitoring) {
		return refused(order, "this main node can't run Ansible");
	}

	const vars = monitoring.vars();

	if (!vars) {
		return refused(order, "the main node is missing GRAFANA_ADMIN_PASSWORD");
	}

	const host = hostOf(target.tailnetUrl);
	const url = `http://${host}:9090/api/v1/write`;
	const work = (async () => {
		const deployed = await ansible.run({
			playbook: "monitoring",
			host,
			vars: { ...vars, stack_dir: target.id === deps.self ? vars.stack_dir : "/opt/colibri" },
		});

		if (!deployed.ok) {
			return deployed;
		}

		await monitoring.setRemoteWriteUrl(url);

		for (const node of await deps.registry.list()) {
			if (node.state === "retired") continue;

			await startAlloy(deps, ansible, node, url);
		}

		return deployed;
	})();

	if (deps.background) {
		deps.background(work);
	} else {
		void work.catch(() => {});
	}

	return done(
		order,
		`deploying Prometheus and Grafana to ${order.node}, then Alloy to every node. Grafana will be at http://${host}:3300`,
	);
};

export const ORDER_TIMEOUTS_MS: Record<ClusterOrder["kind"], number> = {
	shutdown: 30_000,
	resume: 30_000,
	provision: 30_000,
	recover: 30_000,
	deprovision: 10 * 60_000,
	deployStatus: 30_000,
	deployMonitoring: 30_000,
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
		case "deployStatus":
			return deployStatus(deps, order);
		case "deployMonitoring":
			return deployMonitoring(deps, order);
	}
};
