import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		const run = vi.fn(async () => ({ ok, code: ok ? 0 : 2, tail: ["fatal: unreachable"] }));
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

	it("refuses to remove a node that still runs", async () => {
		const { deps: ansibleDeps, run } = withAnsible();

		expect(
			(await handleOrder(ansibleDeps, { kind: "deprovision", id: "d4", node: "eu-3" })).ok,
		).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});
});
