import type { NodeRow } from "@colibri-social/appview/cluster";
import { describe, expect, it } from "vitest";
import {
	createIncident,
	listIncidents,
	parseWhen,
	prependUpdate,
	resolveIncident,
	type StatusDeps,
	StatusUsageError,
	scheduleMaintenance,
	updateIncident,
} from "./commands.js";
import { fakeKuma } from "./fake-kuma.js";

const NOW = new Date("2026-11-11T14:32:00Z");

const node = (id: string): NodeRow => {
	return {
		id,
		region: "eu",
		roles: ["api"],
		publicUrl: `https://${id}.test`,
		tailnetUrl: `http://${id}:3100`,
		version: "2.0.0",
		state: "active",
		connections: 0,
		activeCalls: 0,
		heartbeatAt: NOW.toISOString(),
		drainDeadline: null,
	};
};

const setup = () => {
	const kuma = fakeKuma([
		{ id: 11, name: "eu-1", description: "colibri:node:eu-1", type: "http", url: "", active: true },
		{ id: 12, name: "eu-2", description: "colibri:node:eu-2", type: "http", url: "", active: true },
	]);
	const printed: string[] = [];
	let clock = NOW;
	const deps: StatusDeps = {
		kuma: kuma.api,
		slug: "colibri",
		nodes: async () => [node("eu-1"), node("eu-2")],
		print: (line) => printed.push(line),
		now: () => clock,
	};

	return {
		...kuma,
		deps,
		printed,
		advance: (minutes: number) => {
			clock = new Date(clock.getTime() + minutes * 60_000);
		},
	};
};

describe("incidents", () => {
	it("opens, updates and resolves an incident with a timeline, newest first", async () => {
		const { deps, incidents, advance } = setup();
		const opened = await createIncident(deps, {
			title: "Voice calls drop",
			message: "We're looking into it.",
			style: "danger",
		});

		advance(10);
		await updateIncident(deps, { id: opened.id, message: "Found the cause.", style: "warning" });
		advance(5);
		await resolveIncident(deps, { id: opened.id, message: "Calls work again." });

		expect(incidents[0]).toMatchObject({
			title: "Voice calls drop",
			style: "warning",
			active: false,
			content: [
				"**14:47 UTC** · Calls work again.",
				"**14:42 UTC** · Found the cause.",
				"**14:32 UTC** · We're looking into it.",
			].join("\n\n"),
		});
	});

	it("lists open incidents unless asked for all", async () => {
		const { deps, printed } = setup();
		const first = await createIncident(deps, { title: "First" });

		await createIncident(deps, { title: "Second" });
		await resolveIncident(deps, { id: first.id });
		printed.length = 0;
		await listIncidents(deps, false);

		expect(printed).toHaveLength(1);
		expect(printed[0]).toContain("Second");

		printed.length = 0;
		await listIncidents(deps, true);

		expect(printed).toHaveLength(2);
	});

	it("rejects unknown IDs and styles", async () => {
		const { deps } = setup();

		await expect(updateIncident(deps, { id: 99, message: "x" })).rejects.toThrow(StatusUsageError);
		await expect(createIncident(deps, { title: "x", style: "purple" })).rejects.toThrow(/--style/);
	});
});

describe("prependUpdate", () => {
	it("starts the timeline on an empty incident", () => {
		expect(prependUpdate("", "Hello", NOW)).toBe("**14:32 UTC** · Hello");
	});
});

describe("parseWhen", () => {
	it("reads now, relative times and ISO dates", () => {
		expect(parseWhen("now", NOW)).toEqual(NOW);
		expect(parseWhen("+30m", NOW).toISOString()).toBe("2026-11-11T15:02:00.000Z");
		expect(parseWhen("+2h", NOW).toISOString()).toBe("2026-11-11T16:32:00.000Z");
		expect(parseWhen("+1d", NOW).toISOString()).toBe("2026-11-12T14:32:00.000Z");
		expect(parseWhen("2026-12-01T03:00:00Z", NOW).toISOString()).toBe("2026-12-01T03:00:00.000Z");
		expect(() => parseWhen("tomorrow", NOW)).toThrow(StatusUsageError);
	});
});

describe("scheduleMaintenance", () => {
	it("links the status page and the monitors of the nodes it affects", async () => {
		const { deps, maintenances } = setup();

		await scheduleMaintenance(deps, {
			title: "Postgres upgrade",
			start: "+1h",
			end: "+2h",
			nodes: "eu-2",
		});

		expect(maintenances[0]).toMatchObject({
			title: "Postgres upgrade",
			statusPage: 7,
			monitors: [12],
			startDate: "2026-11-11T15:32:00.000Z",
			endDate: "2026-11-11T16:32:00.000Z",
		});
	});

	it("refuses unknown nodes and an end before the start", async () => {
		const { deps } = setup();

		await expect(
			scheduleMaintenance(deps, { title: "x", start: "now", end: "+1h", nodes: "us-9" }),
		).rejects.toThrow(/us-9/);
		await expect(
			scheduleMaintenance(deps, { title: "x", start: "+2h", end: "+1h" }),
		).rejects.toThrow(/--end/);
	});
});
