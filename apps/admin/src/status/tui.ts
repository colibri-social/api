import type { IncidentStyle, KumaIncident, NodeRow } from "@colibri-social/appview/cluster";
import {
	createIncident,
	endMaintenance,
	INCIDENT_STYLES,
	resolveIncident,
	type StatusDeps,
	scheduleMaintenance,
	updateIncident,
} from "./commands.js";

type Option<T> = { value: T; label: string; hint?: string };

export type Prompts = {
	intro: (title: string) => void;
	outro: (message: string) => void;
	note: (message: string, title?: string) => void;
	select: <T>(options: { message: string; options: Option<T>[] }) => Promise<T | symbol>;
	multiselect: <T>(options: {
		message: string;
		options: Option<T>[];
		required?: boolean;
	}) => Promise<T[] | symbol>;
	text: (options: {
		message: string;
		placeholder?: string;
		initialValue?: string;
		validate?: (value: string | undefined) => string | Error | undefined;
	}) => Promise<string | symbol>;
	confirm: (options: { message: string }) => Promise<boolean | symbol>;
	isCancel: (value: unknown) => value is symbol;
};

type Screen = "home" | "nodes" | "incidents" | "maintenance" | "quit";

const required = (value: string | undefined): string | undefined => {
	return value && value.trim() !== "" ? undefined : "Type something, or press Escape to go back.";
};

const age = (since: string | null, now: Date): string => {
	if (!since) {
		return "never";
	}

	const seconds = Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 1000));

	return seconds < 120 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
};

const nodeDetails = (node: NodeRow, now: Date): string => {
	return [
		`State        ${node.state}`,
		`Region       ${node.region}`,
		`Roles        ${node.roles.join(", ")}`,
		`Version      ${node.version || "unknown"}`,
		`Connections  ${node.connections}`,
		`Calls        ${node.activeCalls}`,
		`Heartbeat    ${age(node.heartbeatAt, now)}`,
		`Public URL   ${node.publicUrl}`,
	].join("\n");
};

export const runStatusTui = async (deps: StatusDeps, prompts: Prompts): Promise<void> => {
	const ask = async <T>(value: Promise<T | symbol>): Promise<T | null> => {
		const answer = await value;

		return prompts.isCancel(answer) ? null : (answer as T);
	};

	const nodes = async (): Promise<Screen> => {
		const list = await deps.nodes();
		const picked = await ask(
			prompts.select<string>({
				message: "Nodes",
				options: [
					...list.map((node) => ({
						value: node.id,
						label: node.id,
						hint: `${node.state} · ${node.region} · ${node.version || "?"}`,
					})),
					{ value: "", label: "Back" },
				],
			}),
		);
		const node = list.find((item) => item.id === picked);

		if (!node) {
			return "home";
		}

		prompts.note(nodeDetails(node, deps.now()), node.id);

		return "nodes";
	};

	const incident = async (current: KumaIncident): Promise<void> => {
		prompts.note(current.content || "No updates yet.", current.title);

		const action = await ask(
			prompts.select<string>({
				message: current.title,
				options: [
					{ value: "update", label: "Post an update" },
					{ value: "resolve", label: "Resolve" },
					{ value: "", label: "Back" },
				],
			}),
		);

		if (action === "update") {
			const message = await ask(prompts.text({ message: "Update", validate: required }));

			if (message) await updateIncident(deps, { id: current.id, message });
		}

		if (action === "resolve") {
			const message = await ask(
				prompts.text({
					message: "Closing update (optional)",
					placeholder: "Everything works again.",
				}),
			);
			const sure = await ask(prompts.confirm({ message: `Resolve "${current.title}"?` }));

			if (sure) {
				await resolveIncident(deps, {
					id: current.id,
					...(message && message.trim() !== "" ? { message } : {}),
				});
			}
		}
	};

	const incidents = async (): Promise<Screen> => {
		const open = (await deps.kuma.incidents(deps.slug)).filter((item) => item.active);
		const picked = await ask(
			prompts.select<number>({
				message: open.length === 0 ? "No incident is open" : "Open incidents",
				options: [
					...open.map((item) => ({ value: item.id, label: item.title, hint: item.style })),
					{ value: -1, label: "Open an incident" },
					{ value: 0, label: "Back" },
				],
			}),
		);

		if (picked === null || picked === 0) {
			return "home";
		}

		if (picked === -1) {
			const title = await ask(prompts.text({ message: "Title", validate: required }));

			if (!title) return "incidents";

			const style = await ask(
				prompts.select<IncidentStyle>({
					message: "Style",
					options: INCIDENT_STYLES.map((value) => ({ value, label: value })),
				}),
			);
			const message = await ask(prompts.text({ message: "First update (optional)" }));

			await createIncident(deps, {
				title,
				style: style ?? "warning",
				...(message && message.trim() !== "" ? { message } : {}),
			});

			return "incidents";
		}

		const current = open.find((item) => item.id === picked);

		if (current) await incident(current);

		return "incidents";
	};

	const maintenance = async (): Promise<Screen> => {
		const windows = await deps.kuma.maintenances();

		if (windows.length > 0) {
			prompts.note(
				windows
					.map(
						(window) =>
							`${window.title} · ${window.status} · ${window.startDate ?? "?"} to ${window.endDate ?? "?"} UTC`,
					)
					.join("\n"),
				"Maintenance",
			);
		}

		const action = await ask(
			prompts.select<string>({
				message: "Maintenance",
				options: [
					{ value: "schedule", label: "Schedule maintenance" },
					...(windows.some((window) => window.active)
						? [{ value: "end", label: "End maintenance now" }]
						: []),
					{ value: "", label: "Back" },
				],
			}),
		);

		if (action === "schedule") {
			const title = await ask(prompts.text({ message: "Title", validate: required }));

			if (!title) return "maintenance";

			const start = await ask(prompts.text({ message: "Starts", initialValue: "now" }));
			const end = await ask(prompts.text({ message: "Ends", initialValue: "+1h" }));
			const affected = await ask(
				prompts.multiselect<string>({
					message: "Nodes it affects",
					options: (await deps.nodes()).map((node) => ({ value: node.id, label: node.id })),
					required: false,
				}),
			);

			await scheduleMaintenance(deps, {
				title,
				start: start ?? "now",
				end: end ?? "+1h",
				nodes: (affected ?? []).join(","),
			});
		}

		if (action === "end") {
			const id = await ask(
				prompts.select<number>({
					message: "Which one?",
					options: windows
						.filter((window) => window.active)
						.map((window) => ({ value: window.id, label: window.title })),
				}),
			);

			if (id !== null) await endMaintenance(deps, id);
		}

		return "maintenance";
	};

	prompts.intro("Colibri status");

	let screen: Screen = "home";

	while (screen !== "quit") {
		if (screen === "home") {
			screen =
				(await ask(
					prompts.select<Screen>({
						message: "What do you want to look at?",
						options: [
							{ value: "nodes", label: "Nodes" },
							{ value: "incidents", label: "Incidents" },
							{ value: "maintenance", label: "Maintenance" },
							{ value: "quit", label: "Quit" },
						],
					}),
				)) ?? "quit";
		} else if (screen === "nodes") {
			screen = await nodes();
		} else if (screen === "incidents") {
			screen = await incidents();
		} else {
			screen = await maintenance();
		}
	}

	prompts.outro("Done.");
};
