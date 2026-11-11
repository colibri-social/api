import type { Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import {
	API_KEY,
	connectKuma,
	createKumaSync,
	desiredMonitors,
	type KumaApi,
	type KumaMonitor,
	nodeKey,
	planMonitors,
	type StatusGroup,
	type StatusPageConfig,
	statusGroups,
} from "./kuma.js";
import type { NodeRow } from "./registry.js";

const node = (id: string, overrides: Partial<NodeRow> = {}): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.nodes.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "1",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: null,
		drainDeadline: null,
		...overrides,
	};
};

const monitor = (id: number, key: string, overrides: Partial<KumaMonitor> = {}): KumaMonitor => {
	const name = key === API_KEY ? "API" : key.replace("colibri:node:", "");
	const url = key === API_KEY ? "https://api.test/health" : `https://${name}.nodes.test/health`;

	return { id, name, description: key, type: "http", url, active: true, ...overrides };
};

const fakeKuma = () => {
	let next = 100;
	const monitors = new Map<number, KumaMonitor>();
	const pages = new Map<string, StatusPageConfig>();
	const saved: { config: StatusPageConfig; icon: string; groups: StatusGroup[] }[] = [];
	const api: KumaApi = {
		monitors: async () => [...monitors.values()],
		add: async (fields) => {
			next += 1;
			monitors.set(next, {
				id: next,
				name: String(fields.name),
				description: String(fields.description),
				type: String(fields.type),
				url: String(fields.url),
				active: fields.active !== false,
			});

			return next;
		},
		remove: async (id) => {
			monitors.delete(id);
		},
		pause: async (id) => {
			const current = monitors.get(id);

			if (current) monitors.set(id, { ...current, active: false });
		},
		resume: async (id) => {
			const current = monitors.get(id);

			if (current) monitors.set(id, { ...current, active: true });
		},
		statusPage: async (slug) => pages.get(slug) ?? null,
		addStatusPage: async (title, slug) => {
			pages.set(slug, { slug, title, icon: "/icon.svg", analyticsType: null });
		},
		saveStatusPage: async (slug, config, icon, groups) => {
			pages.set(slug, config);
			saved.push({ config, icon, groups });
		},
		incidents: async () => [],
		postIncident: async () => {
			throw new Error("not used");
		},
		editIncident: async () => {
			throw new Error("not used");
		},
		resolveIncident: async () => {},
		maintenances: async () => [],
		scheduleMaintenance: async () => 1,
		endMaintenance: async () => {},
		close: () => {},
	};

	return { api, monitors, saved };
};

describe("desiredMonitors", () => {
	it("checks the API and every node that isn't retired, pausing parked and draining ones", () => {
		const desired = desiredMonitors(
			[
				node("eu-2", { state: "maintenance" }),
				node("eu-1"),
				node("us-1", { region: "us", state: "draining" }),
				node("old-1", { state: "retired" }),
			],
			"https://api.test",
		);

		expect(desired.map((entry) => [entry.key, entry.url, entry.active, entry.group])).toEqual([
			[API_KEY, "https://api.test/health", true, "API"],
			[nodeKey("eu-1"), "https://eu-1.nodes.test/health", true, "eu"],
			[nodeKey("eu-2"), "https://eu-2.nodes.test/health", false, "eu"],
			[nodeKey("us-1"), "https://us-1.nodes.test/health", false, "us"],
		]);
	});
});

describe("planMonitors", () => {
	it("adds, removes, pauses and resumes only the monitors it manages", () => {
		const desired = desiredMonitors(
			[node("eu-1"), node("eu-2", { state: "maintenance" }), node("eu-3")],
			"https://api.test",
		);
		const plan = planMonitors(
			[
				monitor(1, API_KEY),
				monitor(2, nodeKey("eu-1"), { active: false }),
				monitor(3, nodeKey("eu-2")),
				monitor(4, nodeKey("gone-1")),
				monitor(5, nodeKey("eu-3"), { url: "https://old.test/health" }),
				{ id: 6, name: "Website", description: null, type: "http", url: "x", active: true },
				monitor(7, nodeKey("eu-1")),
			],
			desired,
		);

		expect(plan.remove).toEqual([4, 5, 7]);
		expect(plan.add.map((entry) => entry.key)).toEqual([nodeKey("eu-3")]);
		expect(plan.pause).toEqual([3]);
		expect(plan.resume).toEqual([2]);
	});
});

describe("statusGroups", () => {
	it("puts the API first, then one group per region", () => {
		const desired = desiredMonitors(
			[node("us-1", { region: "us" }), node("eu-1")],
			"https://api.test",
		);
		const groups = statusGroups(desired, [
			monitor(1, API_KEY),
			monitor(2, nodeKey("eu-1")),
			monitor(3, nodeKey("us-1")),
		]);

		expect(groups).toEqual([
			{ name: "API", monitorList: [{ id: 1 }] },
			{ name: "eu", monitorList: [{ id: 2 }] },
			{ name: "us", monitorList: [{ id: 3 }] },
		]);
	});
});

describe("createKumaSync", () => {
	const sync = (kuma: ReturnType<typeof fakeKuma>, css = "body {}") => {
		return createKumaSync({
			api: kuma.api,
			slug: "colibri",
			title: "Colibri",
			statusHost: "status.test",
			css: async () => css,
			apiUrl: "https://api.test",
			log: { info: vi.fn(), warn: vi.fn() },
		});
	};

	it("creates the monitors and the status page, then saves again only on changes", async () => {
		const kuma = fakeKuma();
		const syncer = sync(kuma);

		await syncer.sync([node("eu-1")]);

		expect([...kuma.monitors.values()].map((entry) => entry.name)).toEqual(["API", "eu-1"]);
		expect(kuma.saved).toHaveLength(1);
		expect(kuma.saved[0]?.config).toMatchObject({
			slug: "colibri",
			title: "Colibri",
			customCSS: "body {}",
			showPoweredBy: false,
			domainNameList: ["status.test"],
		});
		expect(kuma.saved[0]?.groups.map((group) => group.name)).toEqual(["API", "eu"]);

		await syncer.sync([node("eu-1")]);

		expect(kuma.saved).toHaveLength(1);

		await syncer.sync([node("eu-1"), node("us-1", { region: "us" })]);

		expect(kuma.saved).toHaveLength(2);
		expect(kuma.saved[1]?.groups.map((group) => group.name)).toEqual(["API", "eu", "us"]);
	});

	it("pauses a node in maintenance without saving the page again", async () => {
		const kuma = fakeKuma();
		const syncer = sync(kuma);

		await syncer.sync([node("eu-1")]);
		await syncer.sync([node("eu-1", { state: "maintenance" })]);

		expect([...kuma.monitors.values()].find((entry) => entry.name === "eu-1")?.active).toBe(false);
		expect(kuma.saved).toHaveLength(1);
	});
});

describe("connectKuma", () => {
	const fakeSocket = (answers: Record<string, unknown>) => {
		const handlers = new Map<string, (payload: unknown) => void>();
		const emitted: [string, unknown[]][] = [];
		const socket = {
			on: (event: string, handler: (payload: unknown) => void) => {
				handlers.set(event, handler);

				return socket;
			},
			timeout: () => socket,
			emitWithAck: async (event: string, ...args: unknown[]) => {
				emitted.push([event, args]);

				if (event === "getMonitorList") {
					handlers.get("monitorList")?.({
						"3": { id: 3, name: "API", description: API_KEY, type: "http", url: "u", active: 1 },
					});
				}

				return answers[event] ?? { ok: true };
			},
			close: vi.fn(),
		};

		queueMicrotask(() => handlers.get("info")?.({}));

		return { socket: socket as unknown as Socket, emitted, handlers };
	};

	it("sets up a fresh Kuma, logs in once and reads the monitor list", async () => {
		const { socket, emitted } = fakeSocket({ needSetup: true });
		const kuma = connectKuma({
			url: "http://kuma.test",
			username: "colibri",
			password: "pw",
			log: { info: vi.fn(), warn: vi.fn() },
			socket,
		});

		expect(await kuma.monitors()).toEqual([
			{ id: 3, name: "API", description: API_KEY, type: "http", url: "u", active: true },
		]);
		await kuma.pause(3);

		expect(emitted.map(([event]) => event)).toEqual([
			"needSetup",
			"setup",
			"login",
			"getMonitorList",
			"pauseMonitor",
		]);
		expect(emitted[2]?.[1]).toEqual([{ username: "colibri", password: "pw", token: "" }]);
	});

	it("logs in again after a disconnect and reports a 2FA account", async () => {
		const { socket, emitted, handlers } = fakeSocket({
			needSetup: false,
			login: { tokenRequired: true },
		});
		const kuma = connectKuma({
			url: "http://kuma.test",
			username: "colibri",
			password: "pw",
			log: { info: vi.fn(), warn: vi.fn() },
			socket,
		});

		await expect(kuma.monitors()).rejects.toThrow(/2FA/);
		handlers.get("disconnect")?.(undefined);
		handlers.get("info")?.({});
		await expect(kuma.monitors()).rejects.toThrow(/2FA/);

		expect(emitted.filter(([event]) => event === "login")).toHaveLength(2);
	});

	it("turns a refusal into an error", async () => {
		const { socket } = fakeSocket({ needSetup: false, deleteMonitor: { ok: false, msg: "nope" } });
		const kuma = connectKuma({
			url: "http://kuma.test",
			username: "colibri",
			password: "pw",
			log: { info: vi.fn(), warn: vi.fn() },
			socket,
		});

		await expect(kuma.remove(4)).rejects.toThrow("Uptime Kuma refused deleteMonitor: nope");
	});
});
