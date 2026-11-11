import {
	type IncidentStyle,
	type KumaApi,
	type KumaIncident,
	type NodeRow,
	nodeKey,
} from "@colibri-social/appview/cluster";

export const INCIDENT_STYLES: readonly IncidentStyle[] = [
	"info",
	"warning",
	"danger",
	"primary",
	"light",
	"dark",
];

export type StatusDeps = {
	kuma: KumaApi;
	slug: string;
	nodes: () => Promise<NodeRow[]>;
	print: (line: string) => void;
	now: () => Date;
};

export class StatusUsageError extends Error {}

export const parseStyle = (value: string | undefined, fallback: IncidentStyle): IncidentStyle => {
	if (value === undefined) {
		return fallback;
	}

	if (!(INCIDENT_STYLES as readonly string[]).includes(value)) {
		throw new StatusUsageError(`--style has to be one of ${INCIDENT_STYLES.join(", ")}`);
	}

	return value as IncidentStyle;
};

export const parseWhen = (value: string, now: Date): Date => {
	if (value === "now") {
		return now;
	}

	const relative = /^\+(\d+)(m|h|d)$/.exec(value);

	if (relative) {
		const [, amount = "0", unit = "m"] = relative;
		const minutes = Number(amount) * (unit === "d" ? 1_440 : unit === "h" ? 60 : 1);

		return new Date(now.getTime() + minutes * 60_000);
	}

	const parsed = new Date(value);

	if (Number.isNaN(parsed.getTime())) {
		throw new StatusUsageError(`${value} isn't a time. Use now, +30m, +2h, +1d or an ISO date`);
	}

	return parsed;
};

export const updateLine = (message: string, at: Date): string => {
	return `**${at.toISOString().slice(11, 16)} UTC** · ${message.trim()}`;
};

export const prependUpdate = (content: string, message: string, at: Date): string => {
	const line = updateLine(message, at);

	return content.trim() === "" ? line : `${line}\n\n${content.trim()}`;
};

const incidentLine = (incident: KumaIncident): string => {
	const state = incident.active ? "open" : "resolved";

	return `${String(incident.id).padStart(5)}  ${state.padEnd(8)}  ${incident.style.padEnd(7)}  ${incident.createdDate.slice(0, 16)}  ${incident.title}`;
};

export const findIncident = async (deps: StatusDeps, id: number): Promise<KumaIncident> => {
	const incident = (await deps.kuma.incidents(deps.slug, 200)).find((item) => item.id === id);

	if (!incident) {
		throw new StatusUsageError(`no incident has the ID ${id}`);
	}

	return incident;
};

export const listIncidents = async (deps: StatusDeps, all: boolean): Promise<void> => {
	const incidents = (await deps.kuma.incidents(deps.slug)).filter(
		(incident) => all || incident.active,
	);

	if (incidents.length === 0) {
		deps.print(all ? "There are no incidents." : "No incident is open.");

		return;
	}

	for (const incident of incidents) {
		deps.print(incidentLine(incident));
	}
};

export const createIncident = async (
	deps: StatusDeps,
	input: { title: string; message?: string; style?: string },
): Promise<KumaIncident> => {
	const incident = await deps.kuma.postIncident(deps.slug, {
		title: input.title,
		content: input.message ? updateLine(input.message, deps.now()) : "",
		style: parseStyle(input.style, "warning"),
	});

	deps.print(`Opened incident ${incident.id}: ${incident.title}`);

	return incident;
};

export const updateIncident = async (
	deps: StatusDeps,
	input: { id: number; message: string; title?: string; style?: string },
): Promise<KumaIncident> => {
	const current = await findIncident(deps, input.id);
	const updated = await deps.kuma.editIncident(deps.slug, current.id, {
		title: input.title ?? current.title,
		content: prependUpdate(current.content, input.message, deps.now()),
		style: parseStyle(input.style, current.style),
	});

	deps.print(`Updated incident ${updated.id}.`);

	return updated;
};

export const resolveIncident = async (
	deps: StatusDeps,
	input: { id: number; message?: string },
): Promise<void> => {
	const current = await findIncident(deps, input.id);

	if (!current.active) {
		deps.print(`Incident ${current.id} is already resolved.`);

		return;
	}

	if (input.message) {
		await deps.kuma.editIncident(deps.slug, current.id, {
			title: current.title,
			content: prependUpdate(current.content, input.message, deps.now()),
			style: current.style,
		});
	}

	await deps.kuma.resolveIncident(deps.slug, current.id);
	deps.print(`Resolved incident ${current.id}.`);
};

export const listMaintenance = async (deps: StatusDeps): Promise<void> => {
	const windows = await deps.kuma.maintenances();

	if (windows.length === 0) {
		deps.print("No maintenance is scheduled.");

		return;
	}

	for (const window of windows) {
		deps.print(
			`${String(window.id).padStart(5)}  ${window.status.padEnd(17)}  ${window.startDate ?? "?"} to ${window.endDate ?? "?"} UTC  ${window.title}`,
		);
	}
};

export const scheduleMaintenance = async (
	deps: StatusDeps,
	input: { title: string; start: string; end: string; nodes?: string; message?: string },
): Promise<number> => {
	const now = deps.now();
	const start = parseWhen(input.start, now);
	const end = parseWhen(input.end, now);

	if (end.getTime() <= start.getTime()) {
		throw new StatusUsageError("--end has to be after --start");
	}

	const wanted = (input.nodes ?? "")
		.split(",")
		.map((node) => node.trim())
		.filter((node) => node !== "");
	const known = new Set((await deps.nodes()).map((node) => node.id));
	const unknown = wanted.filter((node) => !known.has(node));

	if (unknown.length > 0) {
		throw new StatusUsageError(`no node is called ${unknown.join(", ")}`);
	}

	const keys = new Set(wanted.map(nodeKey));
	const monitors = (await deps.kuma.monitors())
		.filter((monitor) => keys.has(monitor.description ?? ""))
		.map((monitor) => monitor.id);
	const page = await deps.kuma.statusPage(deps.slug);
	const id = await deps.kuma.scheduleMaintenance(
		{ title: input.title, description: input.message ?? "", start, end },
		{ statusPage: typeof page?.id === "number" ? page.id : null, monitors },
	);

	deps.print(
		`Scheduled maintenance ${id} from ${start.toISOString()} to ${end.toISOString()}${wanted.length > 0 ? ` for ${wanted.join(", ")}` : ""}.`,
	);

	return id;
};

export const endMaintenance = async (deps: StatusDeps, id: number): Promise<void> => {
	await deps.kuma.endMaintenance(id);
	deps.print(`Ended maintenance ${id}.`);
};
