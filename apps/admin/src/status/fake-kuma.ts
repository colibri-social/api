import type {
	KumaApi,
	KumaIncident,
	KumaMaintenance,
	KumaMonitor,
} from "@colibri-social/appview/cluster";

export const fakeKuma = (monitors: KumaMonitor[] = []) => {
	let next = 0;
	const incidents: KumaIncident[] = [];
	const maintenances: (KumaMaintenance & { statusPage: number | null; monitors: number[] })[] = [];
	const api = {
		monitors: async () => monitors,
		statusPage: async (slug: string) => ({ slug, id: 7 }),
		incidents: async () => [...incidents].reverse(),
		postIncident: async (_slug: string, input: Omit<KumaIncident, "id">) => {
			next += 1;

			const incident: KumaIncident = {
				id: next,
				title: input.title,
				content: input.content,
				style: input.style,
				pin: true,
				active: true,
				createdDate: "2026-11-11 12:00:00",
				lastUpdatedDate: null,
			};

			incidents.push(incident);

			return incident;
		},
		editIncident: async (_slug: string, id: number, input: Partial<KumaIncident>) => {
			const incident = incidents.find((item) => item.id === id);

			if (!incident) throw new Error("missing");
			Object.assign(incident, input);

			return incident;
		},
		resolveIncident: async (_slug: string, id: number) => {
			const incident = incidents.find((item) => item.id === id);

			if (incident) incident.active = false;
		},
		maintenances: async () => maintenances,
		scheduleMaintenance: async (
			input: { title: string; description: string; start: Date; end: Date },
			links: { statusPage: number | null; monitors: number[] },
		) => {
			next += 1;
			maintenances.push({
				id: next,
				title: input.title,
				description: input.description,
				status: "scheduled",
				active: true,
				startDate: input.start.toISOString(),
				endDate: input.end.toISOString(),
				...links,
			});

			return next;
		},
		endMaintenance: async (id: number) => {
			const window = maintenances.find((item) => item.id === id);

			if (window) {
				window.active = false;
				window.status = "inactive";
			}
		},
		close: () => {},
	} as unknown as KumaApi;

	return { api, incidents, maintenances };
};
