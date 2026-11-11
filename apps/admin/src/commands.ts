import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import {
	type ClusterOrder,
	type ConfigStore,
	isSharedKey,
	NODE_ROLES,
	type NodeRow,
	type OrderResult,
	type Registry,
} from "@colibri-social/appview/cluster";
import type { NodeRole } from "@colibri-social/appview-db";

export type Admin = {
	registry: Registry;
	config: ConfigStore;
	sendOrder: (order: ClusterOrder) => Promise<OrderResult>;
	setRolloutPaused: (paused: boolean) => Promise<void>;
	readFile: (path: string) => Promise<string>;
	now: () => Date;
	print: (line: string) => void;
};

export class UsageError extends Error {}

export class RefusedError extends Error {}

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const parseRoles = (value: string): NodeRole[] => {
	const roles = [
		...new Set(
			value
				.split(",")
				.map((role) => role.trim())
				.filter(Boolean),
		),
	];
	const unknown = roles.filter((role) => !(NODE_ROLES as readonly string[]).includes(role));

	if (roles.length === 0 || unknown.length > 0) {
		throw new UsageError(
			`unknown role ${unknown.join(", ") || "(none)"}, expected any of ${NODE_ROLES.join(", ")}`,
		);
	}

	return roles as NodeRole[];
};

export const parseGrace = (value: string): number => {
	const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());

	if (!match) {
		throw new UsageError(`${value} is not a duration such as 90s, 15m or 2h`);
	}

	const amount = Number(match[1]);

	switch (match[2]) {
		case "s":
			return amount / 60;
		case "h":
			return amount * 60;
		default:
			return amount;
	}
};

const age = (since: string | null, now: Date): string => {
	if (!since) {
		return "never";
	}

	const seconds = Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 1000));

	if (seconds < 120) {
		return `${seconds}s ago`;
	}

	return seconds < 7200 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
};

export const formatTable = (rows: readonly (readonly string[])[]): string[] => {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);

	return rows.map((row) =>
		row
			.map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
			.join("  ")
			.trimEnd(),
	);
};

export const nodeList = async (admin: Admin): Promise<void> => {
	const [nodes, main] = await Promise.all([admin.registry.list(), admin.registry.mainNode()]);

	if (nodes.length === 0) {
		admin.print("No nodes are registered.");

		return;
	}

	const now = admin.now();
	const rows = nodes.map((node: NodeRow) => [
		node.id === main?.id ? `${node.id} *` : node.id,
		node.region,
		node.roles.join(","),
		node.state,
		age(node.heartbeatAt, now),
		String(node.connections),
		String(node.activeCalls),
		node.version || "-",
	]);

	for (const line of formatTable([
		["NODE", "REGION", "ROLES", "STATE", "HEARTBEAT", "SOCKETS", "CALLS", "VERSION"],
		...rows,
	])) {
		admin.print(line);
	}

	admin.print("");
	admin.print("* holds the main role");
};

const runOrder = async (admin: Admin, order: ClusterOrder): Promise<void> => {
	const result = await admin.sendOrder(order);

	if (!result.ok) {
		throw new RefusedError(result.message);
	}

	admin.print(result.message);
};

export const nodeAdd = async (
	admin: Admin,
	options: {
		id: string;
		region: string;
		roles: string;
		publicUrl?: string;
		ip?: string;
		workers?: string;
	},
): Promise<void> => {
	if (options.ip && !options.publicUrl) {
		throw new UsageError("provisioning with --ip needs --public-url");
	}

	if (!NODE_ID.test(options.id)) {
		throw new UsageError(
			`${options.id} is not a node ID. Use lowercase letters, digits and dashes`,
		);
	}

	const roles = parseRoles(options.roles);
	const existing = await admin.registry.node(options.id);

	if (existing && existing.state !== "retired") {
		throw new RefusedError(`${options.id} is already registered and ${existing.state}`);
	}

	const token = await admin.registry.createJoinToken({
		id: options.id,
		region: options.region,
		roles,
	});

	if (options.ip && options.publicUrl) {
		const workers = options.workers === undefined ? undefined : Number(options.workers);

		if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) {
			throw new UsageError(`${options.workers} is not a worker count`);
		}

		await runOrder(admin, {
			kind: "provision",
			id: randomUUID(),
			node: options.id,
			ip: options.ip,
			region: options.region,
			roles,
			publicUrl: options.publicUrl,
			joinToken: token,
			...(workers === undefined ? {} : { workers }),
		});

		return;
	}

	const main = await admin.registry.mainNode();

	admin.print(`Join token for ${options.id}, valid for one hour and usable once:`);
	admin.print("");
	admin.print(`MAIN_NODE_URL=${main?.tailnetUrl ?? "<tailnet URL of the main node>"}`);
	admin.print(`CLUSTER_JOIN_TOKEN=${token}`);
	admin.print(`NODE_PUBLIC_URL=${options.publicUrl ?? "<public URL of the new node>"}`);
	admin.print("NODE_TAILNET_URL=<tailnet URL of the new node, on CLUSTER_PORT>");
	admin.print("");
	admin.print("The node gets its ID, region, roles and the shared settings from the main node.");
};

export const nodeShutdown = async (
	admin: Admin,
	options: {
		id: string;
		maintenance: boolean;
		retire: boolean;
		grace?: string;
		force: boolean;
	},
): Promise<void> => {
	if (options.maintenance === options.retire) {
		throw new UsageError("pass exactly one of --maintenance or --retire");
	}

	await runOrder(admin, {
		kind: "shutdown",
		id: randomUUID(),
		node: options.id,
		mode: options.retire ? "retire" : "maintenance",
		...(options.grace === undefined ? {} : { graceMinutes: parseGrace(options.grace) }),
		...(options.force ? { force: true } : {}),
	});
};

export const nodeResume = async (admin: Admin, id: string): Promise<void> => {
	await runOrder(admin, { kind: "resume", id: randomUUID(), node: id });
};

export const nodeRemove = async (
	admin: Admin,
	options: { id: string; force: boolean },
): Promise<void> => {
	await runOrder(admin, {
		kind: "deprovision",
		id: randomUUID(),
		node: options.id,
		...(options.force ? { force: true } : {}),
	});
};

export const nodeRecover = async (admin: Admin, id: string): Promise<void> => {
	await runOrder(admin, { kind: "recover", id: randomUUID(), node: id });
};

export const statusDeploy = async (admin: Admin, id: string): Promise<void> => {
	await runOrder(admin, { kind: "deployStatus", id: randomUUID(), node: id });
};

export const rollout = async (admin: Admin, paused: boolean): Promise<void> => {
	await admin.setRolloutPaused(paused);
	admin.print(paused ? "Rollouts are paused." : "Rollouts are running.");
};

export const configList = async (admin: Admin): Promise<void> => {
	const keys = await admin.config.keys();

	if (keys.length === 0) {
		admin.print("No shared settings are stored.");

		return;
	}

	for (const key of keys) {
		admin.print(key);
	}
};

export const configSet = async (admin: Admin, key: string, value: string): Promise<void> => {
	if (!isSharedKey(key)) {
		throw new RefusedError(`${key} is not a setting every node shares`);
	}

	await admin.config.set(key, value);
	admin.print(`Stored ${key}. Nodes pick it up when they next start.`);
};

export const configUnset = async (admin: Admin, key: string): Promise<void> => {
	const removed = await admin.config.unset(key);

	admin.print(removed ? `Removed ${key}.` : `${key} was not stored.`);
};

export const configImport = async (
	admin: Admin,
	options: { file: string; dryRun: boolean },
): Promise<void> => {
	const entries = Object.entries(parseEnv(await admin.readFile(options.file))).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
	);
	const shared = entries.filter(([key]) => isSharedKey(key));
	const skipped = entries.filter(([key]) => !isSharedKey(key)).map(([key]) => key);

	if (!options.dryRun) {
		for (const [key, value] of shared) {
			await admin.config.set(key, value);
		}
	}

	admin.print(
		`${options.dryRun ? "Would store" : "Stored"} ${shared.length} shared settings: ${shared.map(([key]) => key).join(", ") || "none"}`,
	);

	if (skipped.length > 0) {
		admin.print(`Kept local to each node: ${skipped.join(", ")}`);
	}
};
