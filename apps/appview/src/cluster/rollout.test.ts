import { describe, expect, it, vi } from "vitest";
import type { AnsibleRunner, PlaybookRun } from "./ansible.js";
import type { NodeRow } from "./registry.js";
import { createRollout, type RolloutDeps, rolloutOrder } from "./rollout.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");

const row = (id: string, overrides: Partial<NodeRow> = {}): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.nodes.test`,
		tailnetUrl: `http://${id}.tail:3100`,
		version: "1.0.0",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: new Date(NOW).toISOString(),
		drainDeadline: null,
		...overrides,
	};
};

const setup = (nodes: NodeRow[], overrides: Partial<RolloutDeps> = {}) => {
	const table = new Map(nodes.map((node) => [node.id, node]));
	let paused = false;
	let clock = NOW;
	const runs: PlaybookRun[] = [];
	const ansible: AnsibleRunner = {
		busy: false,
		run: async (run) => {
			runs.push(run);

			const id = run.host.replace(".tail", "");
			const node = table.get(id);

			if (node && !run.vars.pull_only && !run.vars.detach) {
				table.set(id, {
					...node,
					version: "2.0.0",
					state: "active",
					heartbeatAt: new Date(clock + 1_000).toISOString(),
				});
			}

			return { ok: true, code: 0, tail: [] };
		},
	};
	const send = vi.fn(() => true);
	const deps: RolloutDeps = {
		registry: {
			list: async () => [...table.values()],
			node: async (id) => table.get(id) ?? null,
			mayLeave: async () => ({ allowed: true }),
			rolloutPaused: async () => paused,
			pauseRollout: async () => {
				paused = true;
			},
		},
		self: "hel-1",
		image: "ghcr.io/colibri-social/api:stable",
		stackDir: "/srv/colibri",
		drainMinutes: 120,
		resolve: async () => ({
			digest: "sha256:new",
			version: "2.0.0",
			pinned: "ghcr.io/colibri-social/api@sha256:new",
		}),
		ansible,
		send,
		drained: async () => true,
		active: () => true,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		pollMs: 60_000,
		...overrides,
	};

	return { deps, table, runs, send, paused: () => paused };
};

describe("rolloutOrder", () => {
	it("updates sub nodes first, then the failover node, then the main node", () => {
		const order = rolloutOrder(
			[
				row("hel-1", { roles: ["main", "api"] }),
				row("fsn-1", { roles: ["failover", "api"] }),
				row("us-1"),
				row("eu-2"),
			],
			"hel-1",
		);

		expect(order.map((node) => node.id)).toEqual(["eu-2", "us-1", "fsn-1", "hel-1"]);
	});
});

describe("createRollout", () => {
	it("pulls, drains and restarts each node, then restarts the main node detached", async () => {
		const { deps, runs, send } = setup([
			row("hel-1", { roles: ["main", "api"] }),
			row("fsn-1", { roles: ["failover", "api"] }),
			row("eu-2"),
		]);
		const rollout = createRollout(deps);

		expect(await rollout.tick()).toBe("restarting");
		expect(runs.map((run) => [run.host, run.vars])).toEqual([
			["eu-2.tail", { image: "ghcr.io/colibri-social/api@sha256:new", pull_only: true }],
			["eu-2.tail", { image: "ghcr.io/colibri-social/api@sha256:new" }],
			["fsn-1.tail", { image: "ghcr.io/colibri-social/api@sha256:new", pull_only: true }],
			["fsn-1.tail", { image: "ghcr.io/colibri-social/api@sha256:new" }],
			[
				"hel-1.tail",
				{ image: "ghcr.io/colibri-social/api@sha256:new", detach: true, stack_dir: "/srv/colibri" },
			],
		]);
		expect(send).toHaveBeenCalledWith("eu-2", { t: "drain", mode: "update" });
		expect(await rollout.tick()).toBe("busy");
	});

	it("hands main to the updated failover node before the main node restarts", async () => {
		const { deps, runs } = setup([
			row("hel-1", { roles: ["main", "api"] }),
			row("fsn-1", { roles: ["failover", "api"] }),
		]);
		const yieldMain = vi.fn(async () => true);

		deps.yieldMain = yieldMain;

		expect(await createRollout(deps).tick()).toBe("handedOver");
		expect(yieldMain).toHaveBeenCalledWith("fsn-1");
		expect(runs.map((run) => [run.host, run.vars])).toEqual([
			["fsn-1.tail", { image: "ghcr.io/colibri-social/api@sha256:new", pull_only: true }],
			["fsn-1.tail", { image: "ghcr.io/colibri-social/api@sha256:new" }],
			[
				"hel-1.tail",
				{
					image: "ghcr.io/colibri-social/api@sha256:new",
					pull_only: true,
					stack_dir: "/srv/colibri",
				},
			],
			[
				"hel-1.tail",
				{ image: "ghcr.io/colibri-social/api@sha256:new", detach: true, stack_dir: "/srv/colibri" },
			],
		]);
	});

	it("pauses instead of restarting the main node when the failover node doesn't take over", async () => {
		const { deps, runs, paused } = setup([
			row("hel-1", { roles: ["main", "api"] }),
			row("fsn-1", { roles: ["failover", "api"], version: "2.0.0" }),
		]);

		deps.yieldMain = vi.fn(async () => false);

		expect(await createRollout(deps).tick()).toBe("failed");
		expect(paused()).toBe(true);
		expect(runs.some((run) => run.vars.detach)).toBe(false);
	});

	it("restarts the main node in place without a node to take over", async () => {
		const { deps, runs } = setup([row("hel-1", { roles: ["main", "api"] }), row("eu-2")]);
		const yieldMain = vi.fn(async () => true);

		deps.yieldMain = yieldMain;

		expect(await createRollout(deps).tick()).toBe("restarting");
		expect(yieldMain).not.toHaveBeenCalled();
		expect(runs.at(-1)?.vars).toMatchObject({ detach: true });
	});

	it("does nothing when every node runs the stable version", async () => {
		const { deps, runs } = setup([row("hel-1", { version: "2.0.0" })]);

		expect(await createRollout(deps).tick()).toBe("current");
		expect(runs).toEqual([]);
	});

	it("skips parked and silent nodes", async () => {
		const { deps, runs } = setup([
			row("hel-1", { version: "2.0.0" }),
			row("eu-2", { state: "maintenance" }),
			row("eu-3", { heartbeatAt: new Date(NOW - 10 * 60_000).toISOString() }),
		]);

		expect(await createRollout(deps).tick()).toBe("current");
		expect(runs).toEqual([]);
	});

	it("waits for the next tick when quorum doesn't allow the node to leave", async () => {
		const { deps, runs, paused } = setup([row("hel-1", { version: "2.0.0" }), row("eu-2")]);

		deps.registry.mayLeave = async () => ({ allowed: false, reason: "below the floor" });

		expect(await createRollout(deps).tick()).toBe("waiting");
		expect(runs).toEqual([]);
		expect(paused()).toBe(false);
	});

	it("pauses the rollout when a node doesn't finish draining", async () => {
		const { deps, runs, paused } = setup([row("hel-1"), row("eu-2")], {
			drained: async () => false,
		});

		expect(await createRollout(deps).tick()).toBe("failed");
		expect(paused()).toBe(true);
		expect(runs).toHaveLength(1);
	});

	it("pauses the rollout when a node comes back on the old version", async () => {
		const { deps, table, paused } = setup([row("hel-1"), row("eu-2")]);
		const run = deps.ansible.run;

		deps.ansible = {
			busy: false,
			run: async (playbook) => {
				const result = await run(playbook);

				table.set("eu-2", row("eu-2"));

				return result;
			},
		};

		expect(await createRollout(deps).tick()).toBe("failed");
		expect(paused()).toBe(true);
	});

	it("honors a paused rollout", async () => {
		const { deps, runs } = setup([row("hel-1"), row("eu-2")]);

		await deps.registry.pauseRollout();

		expect(await createRollout(deps).tick()).toBe("paused");
		expect(runs).toEqual([]);
	});

	it("keeps going when the registry can't be reached and reports images without a version", async () => {
		const unreachable = setup([row("eu-2")], {
			resolve: async () => {
				throw new Error("offline");
			},
		});

		expect(await createRollout(unreachable.deps).tick()).toBe("unreachable");

		const unversioned = setup([row("eu-2")], {
			resolve: async () => ({ digest: "sha256:x", version: null, pinned: "x" }),
		});

		expect(await createRollout(unversioned.deps).tick()).toBe("unversioned");
	});

	it("stays idle while the node isn't main or is draining", async () => {
		const { deps, runs } = setup([row("eu-2")], { active: () => false });

		expect(await createRollout(deps).tick()).toBe("busy");
		expect(runs).toEqual([]);
	});
});
