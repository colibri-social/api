import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookRun } from "./ansible.js";
import { handleOrder, type OrderDeps } from "./orders.js";
import { createRegistry } from "./registry.js";

let database: TestDatabase;
let deps: OrderDeps & { send: ReturnType<typeof vi.fn> };

const register = (id: string) => {
	return deps.registry.register(
		{ id, region: "eu", roles: ["api"] },
		{ publicUrl: `https://${id}.test`, tailnetUrl: `http://${id}:3100`, version: "1" },
	);
};

beforeEach(async () => {
	database = await openTestDatabase();
	deps = { registry: createRegistry(database), self: "eu-1", send: vi.fn(() => true) };

	for (const id of ["eu-1", "eu-2", "eu-3"]) {
		await register(id);
	}
});

afterEach(async () => {
	await database.destroy();
});

describe("shutdown orders", () => {
	it("drains a node when the rest keep quorum", async () => {
		const result = await handleOrder(deps, {
			kind: "shutdown",
			id: "o1",
			node: "eu-3",
			mode: "maintenance",
			graceMinutes: 15,
		});

		expect(result).toMatchObject({ id: "o1", ok: true });
		expect(deps.send).toHaveBeenCalledWith("eu-3", {
			t: "drain",
			mode: "maintenance",
			graceMinutes: 15,
		});
		expect((await deps.registry.node("eu-3"))?.state).toBe("draining");
	});

	it("refuses a shutdown that would break quorum unless forced", async () => {
		await deps.registry.setState("eu-3", "draining");

		const refused = await handleOrder(deps, {
			kind: "shutdown",
			id: "o2",
			node: "eu-2",
			mode: "retire",
		});

		expect(refused.ok).toBe(false);
		expect(refused.message).toMatch(/--force/);
		expect(deps.send).not.toHaveBeenCalled();

		const forced = await handleOrder(deps, {
			kind: "shutdown",
			id: "o3",
			node: "eu-2",
			mode: "retire",
			force: true,
		});

		expect(forced.ok).toBe(true);
	});

	it("refuses to shut down the main node itself", async () => {
		const result = await handleOrder(deps, {
			kind: "shutdown",
			id: "o4",
			node: "eu-1",
			mode: "maintenance",
			force: true,
		});

		expect(result.ok).toBe(false);
	});

	it("marks a node that is not connected only when forced", async () => {
		deps.send.mockReturnValue(false);

		const refused = await handleOrder(deps, {
			kind: "shutdown",
			id: "o5",
			node: "eu-3",
			mode: "maintenance",
		});

		expect(refused.ok).toBe(false);

		const forced = await handleOrder(deps, {
			kind: "shutdown",
			id: "o6",
			node: "eu-3",
			mode: "maintenance",
			force: true,
		});

		expect(forced.ok).toBe(true);
		expect((await deps.registry.node("eu-3"))?.state).toBe("maintenance");
	});
});

describe("resume orders", () => {
	it("brings a node out of maintenance", async () => {
		await deps.registry.setState("eu-3", "maintenance");

		const result = await handleOrder(deps, { kind: "resume", id: "o7", node: "eu-3" });

		expect(result.ok).toBe(true);
		expect(deps.send).toHaveBeenCalledWith("eu-3", { t: "resume" });
		expect((await deps.registry.node("eu-3"))?.state).toBe("active");
	});

	it("refuses to resume a retired node", async () => {
		await deps.registry.setState("eu-3", "retired");

		expect((await handleOrder(deps, { kind: "resume", id: "o8", node: "eu-3" })).ok).toBe(false);
	});
});

describe("Ansible orders", () => {
	const withAnsible = (ok = true) => {
		const run = vi.fn(async (_run: PlaybookRun) => ({
			ok,
			code: ok ? 0 : 2,
			tail: ["fatal: unreachable"],
		}));
		const removeNode = vi.fn(async () => {});
		const background = vi.fn();

		return {
			run,
			removeNode,
			background,
			deps: {
				...deps,
				ansible: { run, busy: false },
				provisioning: {
					missing: (): string[] => [],
					vars: async () => ({ node_id: "eu-4" }),
					removeNode,
				},
				background,
			} satisfies OrderDeps,
		};
	};

	it("starts provisioning in the background and answers at once", async () => {
		const { deps: ansibleDeps, run, background } = withAnsible();
		const result = await handleOrder(ansibleDeps, {
			kind: "provision",
			id: "p1",
			node: "eu-4",
			ip: "203.0.113.7",
			region: "eu",
			roles: ["api"],
			publicUrl: "https://eu-4.test",
			joinToken: "t",
		});

		expect(result.ok).toBe(true);
		expect(run).toHaveBeenCalledWith({
			playbook: "bootstrap",
			host: "203.0.113.7",
			vars: { node_id: "eu-4" },
		});
		expect(background).toHaveBeenCalled();
	});

	it("refuses to provision without the main node's secrets", async () => {
		const { deps: ansibleDeps } = withAnsible();

		ansibleDeps.provisioning.missing = () => ["TAILSCALE_AUTH_KEY"];

		const result = await handleOrder(ansibleDeps, {
			kind: "provision",
			id: "p2",
			node: "eu-4",
			ip: "203.0.113.7",
			region: "eu",
			roles: ["api"],
			publicUrl: "https://eu-4.test",
			joinToken: "t",
		});

		expect(result).toMatchObject({
			ok: false,
			message: "the main node is missing TAILSCALE_AUTH_KEY",
		});
	});

	it("removes a retired node over the tailnet, then forgets it", async () => {
		const { deps: ansibleDeps, run, removeNode } = withAnsible();

		await deps.registry.setState("eu-3", "retired");

		const result = await handleOrder(ansibleDeps, { kind: "deprovision", id: "d1", node: "eu-3" });

		expect(result.ok).toBe(true);
		expect(run).toHaveBeenCalledWith({ playbook: "remove", host: "eu-3", vars: {} });
		expect(removeNode).toHaveBeenCalledWith("eu-3");
	});

	it("keeps a node whose removal failed unless forced", async () => {
		const { deps: ansibleDeps, removeNode } = withAnsible(false);

		await deps.registry.setState("eu-3", "retired");

		expect(
			(await handleOrder(ansibleDeps, { kind: "deprovision", id: "d2", node: "eu-3" })).ok,
		).toBe(false);
		expect(removeNode).not.toHaveBeenCalled();
		expect(
			(await handleOrder(ansibleDeps, { kind: "deprovision", id: "d3", node: "eu-3", force: true }))
				.ok,
		).toBe(true);
	});

	it("sets the node's DNS record before provisioning", async () => {
		const { deps: ansibleDeps, run } = withAnsible();
		const put = vi.fn(async () => {});
		const result = await handleOrder(
			{ ...ansibleDeps, dns: { put, remove: vi.fn(async () => true) } },
			{
				kind: "provision",
				id: "p3",
				node: "eu-4",
				ip: "203.0.113.7",
				region: "eu",
				roles: ["api"],
				publicUrl: "https://eu-4.test",
				joinToken: "t",
			},
		);

		expect(result.ok).toBe(true);
		expect(put).toHaveBeenCalledWith("eu-4", "eu-4.test", "203.0.113.7");
		expect(run).toHaveBeenCalled();
	});

	it("refuses to provision when the DNS record can't be set", async () => {
		const { deps: ansibleDeps, run } = withAnsible();
		const put = vi.fn(async () => {
			throw new Error("eu-4.test already has a DNS record that Colibri doesn't manage");
		});
		const result = await handleOrder(
			{ ...ansibleDeps, dns: { put, remove: vi.fn(async () => true) } },
			{
				kind: "provision",
				id: "p4",
				node: "eu-4",
				ip: "203.0.113.7",
				region: "eu",
				roles: ["api"],
				publicUrl: "https://eu-4.test",
				joinToken: "t",
			},
		);

		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/doesn't manage/);
		expect(run).not.toHaveBeenCalled();
	});

	it("removes the DNS record of a removed node", async () => {
		const { deps: ansibleDeps } = withAnsible();
		const remove = vi.fn(async () => true);

		await deps.registry.setState("eu-3", "retired");

		const result = await handleOrder(
			{ ...ansibleDeps, dns: { put: vi.fn(async () => {}), remove } },
			{ kind: "deprovision", id: "d5", node: "eu-3" },
		);

		expect(result).toMatchObject({ ok: true, message: "removed eu-3" });
		expect(remove).toHaveBeenCalledWith("eu-3.test");
	});

	it("deploys Uptime Kuma to a node and points the status host at it", async () => {
		const { deps: ansibleDeps, run } = withAnsible();
		const alias = vi.fn(async () => {});
		const result = await handleOrder(
			{
				...ansibleDeps,
				dns: { put: vi.fn(async () => {}), remove: vi.fn(async () => true), alias },
				status: {
					host: "status.test",
					vars: (target) => ({ status_host: "status.test", self: target.self }),
				},
			},
			{ kind: "deployStatus", id: "s1", node: "eu-1" },
		);

		expect(result.ok).toBe(true);
		expect(result.message).toMatch(/KUMA_URL to http:\/\/eu-1:3001/);
		expect(alias).toHaveBeenCalledWith("status.test", "eu-1.test");
		expect(run).toHaveBeenCalledWith({
			playbook: "uptime-kuma",
			host: "eu-1",
			vars: { status_host: "status.test", self: true },
		});
	});

	it("refuses to deploy Uptime Kuma without a status host", async () => {
		const { deps: ansibleDeps, run } = withAnsible();
		const result = await handleOrder(
			{ ...ansibleDeps, status: { host: null, vars: () => null } },
			{ kind: "deployStatus", id: "s2", node: "eu-2" },
		);

		expect(result).toMatchObject({
			ok: false,
			message: "the main node is missing KUMA_PUBLIC_URL",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("deploys monitoring, stores the remote write URL and starts Alloy on every node", async () => {
		const { deps: ansibleDeps, run, background } = withAnsible();
		const setRemoteWriteUrl = vi.fn(async () => {});
		const result = await handleOrder(
			{
				...ansibleDeps,
				monitoring: {
					vars: () => ({ grafana_admin_password: "pw", stack_dir: "/srv/colibri" }),
					remoteWriteUrl: () => null,
					setRemoteWriteUrl,
					alloyVars: (node, self, url) => ({ node: node.id, self, url }),
				},
			},
			{ kind: "deployMonitoring", id: "m1", node: "eu-2" },
		);

		expect(result.ok).toBe(true);
		expect(result.message).toMatch(/http:\/\/eu-2:3300/);

		await background.mock.calls[0]?.[0];

		expect(setRemoteWriteUrl).toHaveBeenCalledWith("http://eu-2:9090/api/v1/write");
		expect(run.mock.calls.map(([call]) => [call.playbook, call.host, call.vars])).toEqual([
			["monitoring", "eu-2", { grafana_admin_password: "pw", stack_dir: "/opt/colibri" }],
			["alloy", "eu-1", { node: "eu-1", self: true, url: "http://eu-2:9090/api/v1/write" }],
			["alloy", "eu-2", { node: "eu-2", self: false, url: "http://eu-2:9090/api/v1/write" }],
			["alloy", "eu-3", { node: "eu-3", self: false, url: "http://eu-2:9090/api/v1/write" }],
		]);
	});

	it("refuses to deploy monitoring without a Grafana password", async () => {
		const { deps: ansibleDeps, run } = withAnsible();
		const result = await handleOrder(
			{
				...ansibleDeps,
				monitoring: {
					vars: () => null,
					remoteWriteUrl: () => null,
					setRemoteWriteUrl: vi.fn(async () => {}),
					alloyVars: () => ({}),
				},
			},
			{ kind: "deployMonitoring", id: "m2", node: "eu-2" },
		);

		expect(result).toMatchObject({
			ok: false,
			message: "the main node is missing GRAFANA_ADMIN_PASSWORD",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("starts Alloy on a new node once monitoring exists", async () => {
		const { deps: ansibleDeps, run, background } = withAnsible();

		await handleOrder(
			{
				...ansibleDeps,
				monitoring: {
					vars: () => null,
					remoteWriteUrl: () => "http://eu-2:9090/api/v1/write",
					setRemoteWriteUrl: vi.fn(async () => {}),
					alloyVars: (node) => ({ node: node.id }),
				},
			},
			{
				kind: "provision",
				id: "p5",
				node: "eu-3",
				ip: "203.0.113.7",
				region: "eu",
				roles: ["api"],
				publicUrl: "https://eu-3.test",
				joinToken: "t",
			},
		);
		await background.mock.calls[0]?.[0];

		expect(run.mock.calls.map(([call]) => call.playbook)).toEqual(["bootstrap", "alloy"]);
	});

	it("refuses to remove a node that still runs", async () => {
		const { deps: ansibleDeps, run } = withAnsible();

		expect(
			(await handleOrder(ansibleDeps, { kind: "deprovision", id: "d4", node: "eu-3" })).ok,
		).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});
});
