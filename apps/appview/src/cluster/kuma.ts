import { io, type Socket } from "socket.io-client";
import type { Logger } from "../logger.js";
import type { NodeRow } from "./registry.js";

export const KEY_PREFIX = "colibri:";

export const API_KEY = "colibri:api";

export const CALL_TIMEOUT_MS = 15_000;

export type KumaMonitor = {
	id: number;
	name: string;
	description: string | null;
	type: string;
	url: string | null;
	active: boolean;
};

export type StatusPageConfig = Record<string, unknown> & {
	slug: string;
	icon?: string;
	customCSS?: string | null;
	domainNameList?: string[];
};

export type StatusGroup = {
	name: string;
	monitorList: { id: number }[];
};

export type KumaApi = {
	monitors: () => Promise<KumaMonitor[]>;
	add: (monitor: Record<string, unknown>) => Promise<number>;
	remove: (id: number) => Promise<void>;
	pause: (id: number) => Promise<void>;
	resume: (id: number) => Promise<void>;
	statusPage: (slug: string) => Promise<StatusPageConfig | null>;
	addStatusPage: (title: string, slug: string) => Promise<void>;
	saveStatusPage: (
		slug: string,
		config: StatusPageConfig,
		icon: string,
		groups: StatusGroup[],
	) => Promise<void>;
	close: () => void;
};

export type DesiredMonitor = {
	key: string;
	name: string;
	url: string;
	active: boolean;
	group: string;
};

export type MonitorPlan = {
	add: DesiredMonitor[];
	remove: number[];
	pause: number[];
	resume: number[];
};

export type KumaSyncOptions = {
	api: KumaApi;
	slug: string;
	title: string;
	statusHost: string | null;
	css: () => Promise<string>;
	apiUrl: string;
	log: Pick<Logger, "info" | "warn">;
};

type Ack = { ok?: boolean; msg?: string; monitorID?: number; config?: StatusPageConfig };

const API_GROUP = "API";

const healthUrl = (base: string): string => {
	return new URL("/health", base).toString();
};

export const nodeKey = (id: string): string => {
	return `${KEY_PREFIX}node:${id}`;
};

export const desiredMonitors = (nodes: readonly NodeRow[], apiUrl: string): DesiredMonitor[] => {
	const monitors: DesiredMonitor[] = [
		{ key: API_KEY, name: "API", url: healthUrl(apiUrl), active: true, group: API_GROUP },
	];

	for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
		if (node.state === "retired") continue;

		monitors.push({
			key: nodeKey(node.id),
			name: node.id,
			url: healthUrl(node.publicUrl),
			active: node.state !== "maintenance" && node.state !== "draining",
			group: node.region,
		});
	}

	return monitors;
};

export const planMonitors = (
	existing: readonly KumaMonitor[],
	desired: readonly DesiredMonitor[],
): MonitorPlan => {
	const plan: MonitorPlan = { add: [], remove: [], pause: [], resume: [] };
	const wanted = new Map(desired.map((monitor) => [monitor.key, monitor]));
	const kept = new Set<string>();

	for (const monitor of existing) {
		const key = monitor.description ?? "";

		if (!key.startsWith(KEY_PREFIX)) continue;

		const target = wanted.get(key);

		if (
			!target ||
			kept.has(key) ||
			monitor.type !== "http" ||
			monitor.name !== target.name ||
			monitor.url !== target.url
		) {
			plan.remove.push(monitor.id);
			continue;
		}

		kept.add(key);

		if (monitor.active && !target.active) plan.pause.push(monitor.id);
		if (!monitor.active && target.active) plan.resume.push(monitor.id);
	}

	for (const monitor of desired) {
		if (!kept.has(monitor.key)) plan.add.push(monitor);
	}

	return plan;
};

export const statusGroups = (
	desired: readonly DesiredMonitor[],
	monitors: readonly KumaMonitor[],
): StatusGroup[] => {
	const ids = new Map(monitors.map((monitor) => [monitor.description ?? "", monitor.id]));
	const groups = new Map<string, number[]>();

	for (const monitor of desired) {
		const id = ids.get(monitor.key);

		if (id === undefined) continue;

		groups.set(monitor.group, [...(groups.get(monitor.group) ?? []), id]);
	}

	const names = [...groups.keys()].sort((a, b) =>
		a === API_GROUP ? -1 : b === API_GROUP ? 1 : a.localeCompare(b),
	);

	return names.map((name) => ({
		name,
		monitorList: (groups.get(name) ?? []).map((id) => ({ id })),
	}));
};

export const monitorFields = (monitor: DesiredMonitor): Record<string, unknown> => {
	return {
		type: "http",
		name: monitor.name,
		description: monitor.key,
		parent: null,
		url: monitor.url,
		method: "GET",
		interval: 60,
		retryInterval: 60,
		resendInterval: 0,
		maxretries: 1,
		timeout: 30,
		active: monitor.active,
		notificationIDList: {},
		ignoreTls: false,
		upsideDown: false,
		expiryNotification: false,
		maxredirects: 0,
		accepted_statuscodes: ["200-299"],
		conditions: [],
		kafkaProducerBrokers: [],
		kafkaProducerSaslOptions: { mechanism: "None" },
		rabbitmqNodes: [],
		httpBodyEncoding: "json",
	};
};

const toMonitors = (list: unknown): KumaMonitor[] => {
	if (!list || typeof list !== "object") {
		return [];
	}

	return Object.values(list as Record<string, Record<string, unknown>>).map((monitor) => ({
		id: Number(monitor.id),
		name: String(monitor.name ?? ""),
		description: typeof monitor.description === "string" ? monitor.description : null,
		type: String(monitor.type ?? ""),
		url: typeof monitor.url === "string" ? monitor.url : null,
		active: Boolean(monitor.active),
	}));
};

export const connectKuma = (options: {
	url: string;
	username: string;
	password: string;
	log: Pick<Logger, "info" | "warn">;
	socket?: Socket;
}): KumaApi => {
	const socket =
		options.socket ??
		io(options.url, { transports: ["websocket"], reconnection: true, autoConnect: true });
	let latest: KumaMonitor[] = [];
	let ready: Promise<void> | null = null;
	let greeted: Promise<void> = new Promise(() => {});
	let greet: () => void = () => {};

	const awaitGreeting = () => {
		greeted = new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Uptime Kuma didn't answer the connection")),
				CALL_TIMEOUT_MS,
			);

			greet = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		greeted.catch(() => {});
	};

	awaitGreeting();

	const call = async (event: string, ...args: unknown[]): Promise<Ack> => {
		const answer = (await socket.timeout(CALL_TIMEOUT_MS).emitWithAck(event, ...args)) as
			| Ack
			| boolean;

		if (typeof answer === "object" && answer !== null && answer.ok === false) {
			throw new Error(`Uptime Kuma refused ${event}: ${answer.msg ?? "no reason given"}`);
		}

		return typeof answer === "object" && answer !== null ? answer : { ok: Boolean(answer) };
	};

	const signIn = async (): Promise<void> => {
		await greeted;

		const needSetup = (await socket.timeout(CALL_TIMEOUT_MS).emitWithAck("needSetup")) === true;

		if (needSetup) {
			await call("setup", options.username, options.password);
			options.log.info("kuma.setUp");
		}

		const login = await call("login", {
			username: options.username,
			password: options.password,
			token: "",
		});

		if (login.ok !== true) {
			throw new Error("Uptime Kuma wants a 2FA code. Turn 2FA off for this account");
		}

		options.log.info("kuma.loggedIn");
	};

	const authed = (): Promise<void> => {
		ready ??= signIn().catch((error: unknown) => {
			ready = null;

			throw error;
		});

		return ready;
	};

	socket.on("monitorList", (list: unknown) => {
		latest = toMonitors(list);
	});
	socket.on("info", () => greet());
	socket.on("disconnect", () => {
		ready = null;
		awaitGreeting();
	});

	return {
		monitors: async () => {
			await authed();
			await call("getMonitorList");

			return latest;
		},
		add: async (monitor) => {
			await authed();

			const answer = await call("add", monitor);

			return Number(answer.monitorID);
		},
		remove: async (id) => {
			await authed();
			await call("deleteMonitor", id, false);
		},
		pause: async (id) => {
			await authed();
			await call("pauseMonitor", id);
		},
		resume: async (id) => {
			await authed();
			await call("resumeMonitor", id);
		},
		statusPage: async (slug) => {
			await authed();

			const answer = (await socket
				.timeout(CALL_TIMEOUT_MS)
				.emitWithAck("getStatusPage", slug)) as Ack;

			return answer.ok ? (answer.config ?? null) : null;
		},
		addStatusPage: async (title, slug) => {
			await authed();
			await call("addStatusPage", title, slug);
		},
		saveStatusPage: async (slug, config, icon, groups) => {
			await authed();
			await call("saveStatusPage", slug, config, icon, groups);
		},
		close: () => {
			socket.close();
		},
	};
};

export const createKumaSync = (options: KumaSyncOptions) => {
	let savedPage: string | null = null;

	const syncPage = async (desired: readonly DesiredMonitor[]): Promise<void> => {
		const monitors = await options.api.monitors();
		const groups = statusGroups(desired, monitors);
		const css = await options.css();
		const fingerprint = JSON.stringify({ groups, css, host: options.statusHost });

		if (fingerprint === savedPage) {
			return;
		}

		let config = await options.api.statusPage(options.slug);

		if (!config) {
			await options.api.addStatusPage(options.title, options.slug);
			config = await options.api.statusPage(options.slug);
			options.log.info({ slug: options.slug }, "kuma.statusPageCreated");
		}

		if (!config) {
			throw new Error(`Uptime Kuma didn't create the ${options.slug} status page`);
		}

		await options.api.saveStatusPage(
			options.slug,
			{
				...config,
				slug: options.slug,
				customCSS: css,
				showPoweredBy: false,
				analyticsType: config.analyticsType ?? null,
				domainNameList: options.statusHost ? [options.statusHost] : [],
			},
			config.icon ?? "/icon.svg",
			groups,
		);
		savedPage = fingerprint;
		options.log.info({ slug: options.slug, groups: groups.length }, "kuma.statusPageSaved");
	};

	return {
		sync: async (nodes: readonly NodeRow[]): Promise<MonitorPlan> => {
			const desired = desiredMonitors(nodes, options.apiUrl);
			const plan = planMonitors(await options.api.monitors(), desired);

			for (const id of plan.remove) await options.api.remove(id);
			for (const monitor of plan.add) await options.api.add(monitorFields(monitor));
			for (const id of plan.pause) await options.api.pause(id);
			for (const id of plan.resume) await options.api.resume(id);

			if (plan.add.length + plan.remove.length + plan.pause.length + plan.resume.length > 0) {
				options.log.info(
					{
						added: plan.add.length,
						removed: plan.remove.length,
						paused: plan.pause.length,
						resumed: plan.resume.length,
					},
					"kuma.monitorsSynced",
				);
			}

			await syncPage(desired);

			return plan;
		},
	};
};
