#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import {
	CLUSTER_STATE_ID,
	connectKuma,
	createConfigStore,
	createRegistry,
	promoteLocal,
	slotName,
} from "@colibri-social/appview/cluster";
import { hostUrls, openDatabase, pickPrimary, probeHost } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import {
	type Admin,
	configImport,
	configList,
	configSet,
	configUnset,
	dbFailback,
	dbSwitchover,
	monitoringDeploy,
	nodeAdd,
	nodeList,
	nodeRecover,
	nodeRemove,
	nodeResume,
	nodeShutdown,
	RefusedError,
	rollout,
	statusDeploy,
	UsageError,
} from "./commands.js";
import { CopyRefusedError, copyDatabase } from "./db-copy.js";
import { openOrderBus, sendOrder } from "./orders.js";
import {
	createIncident,
	endMaintenance,
	listIncidents,
	listMaintenance,
	resolveIncident,
	type StatusDeps,
	StatusUsageError,
	scheduleMaintenance,
	updateIncident,
} from "./status/commands.js";
import { type Prompts, runStatusTui } from "./status/tui.js";

const USAGE = `colibri-admin, run it inside the AppView container of the main node

  node list
  node add <id> --region <region> --roles <roles> [--public-url <url>]
                   [--ip <public ip> [--workers <n>]]
  node shutdown <id> --maintenance|--retire [--grace 15m] [--force]
  node resume <id>
  node recover <id>
  node remove <id> [--force]
  rollout pause|resume
  status
  status deploy <node>
  status incident list [--all]
  status incident create <title> [--message <text>] [--style warning]
  status incident update <id> <message> [--title <text>] [--style <style>]
  status incident resolve <id> [<message>]
  status maintenance list
  status maintenance schedule <title> --start now|+30m|<ISO> --end +2h|<ISO> [--nodes a,b] [--message <text>]
  status maintenance end <id>
  monitoring deploy <node>
  config list
  config set <KEY> <value>
  config unset <KEY>
  config import <file|-> [--dry-run]
  db copy --from <libSQL url> --to <Postgres url> [--truncate]
  db failback [<node>]
  db switchover <node>
  db promote`;

const fail = (message: string, code: number): never => {
	process.stderr.write(`${message}\n`);
	process.exit(code);
};

const required = (value: string | undefined, name: string): string => {
	if (!value) {
		throw new UsageError(`missing ${name}`);
	}

	return value;
};

const promoteHere = async (): Promise<number> => {
	const localUrl = process.env.LOCAL_POSTGRES_URL || process.env.DATABASE_READ_URL;
	const databaseUrl = process.env.DATABASE_URL;
	const nodeId = process.env.NODE_ID;

	if (!localUrl || !databaseUrl || !nodeId) {
		process.stderr.write(
			"db promote runs on a failover node with LOCAL_POSTGRES_URL or DATABASE_READ_URL, DATABASE_URL and NODE_ID\n",
		);

		return 2;
	}

	const primary = pickPrimary(
		await Promise.all(hostUrls(databaseUrl).map((url) => probeHost(url))),
	);

	if (primary) {
		process.stderr.write(
			"A primary still accepts writes. Fail over only when it's gone, or use db failback\n",
		);

		return 1;
	}

	const local = openDatabase({ url: localUrl, maxConnections: 1 });
	const slots = await local.primary
		.select({ id: local.tables.nodes.id, state: local.tables.nodes.state })
		.from(local.tables.nodes)
		.then((rows) =>
			rows
				.filter((row) => row.id !== nodeId && row.state !== "retired")
				.map((row) => slotName(row.id)),
		)
		.catch(() => [] as string[])
		.finally(() => local.close());

	try {
		const epoch = await promoteLocal({
			localUrl,
			nodeId,
			slots,
			log: { info: () => {}, warn: () => {} },
		});

		process.stdout.write(`Promoted this node's Postgres. The cluster is on epoch ${epoch}.\n`);

		return 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

		return 1;
	}
};

const runDbCommand = async (
	command: string | undefined,
	values: { from?: string | undefined; to?: string | undefined; truncate?: boolean },
): Promise<number> => {
	if (command === "promote") {
		return promoteHere();
	}

	if (command !== "copy" || !values.from || !values.to) {
		process.stderr.write(`db copy needs --from and --to\n\n${USAGE}\n`);

		return 2;
	}

	const source = openDatabase({ url: values.from, maxConnections: 2 });
	const target = openDatabase({ url: values.to, maxConnections: 4 });
	const started = Date.now();

	try {
		const copied = await copyDatabase({
			source,
			target,
			truncate: values.truncate ?? false,
			print: (line) => process.stdout.write(`${line}\n`),
		});
		const rows = copied.reduce((total, table) => total + table.rows, 0);

		process.stdout.write(
			`Copied ${rows} rows in ${copied.length} tables in ${Math.round((Date.now() - started) / 1000)} s. Row counts match.\n`,
		);

		return 0;
	} catch (error) {
		if (error instanceof CopyRefusedError) {
			process.stderr.write(`${error.message}\n`);

			return 1;
		}

		throw error;
	} finally {
		await source.close();
		await target.close();
	}
};

const main = async (): Promise<void> => {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			region: { type: "string" },
			roles: { type: "string" },
			"public-url": { type: "string" },
			ip: { type: "string" },
			workers: { type: "string" },
			maintenance: { type: "boolean", default: false },
			retire: { type: "boolean", default: false },
			grace: { type: "string" },
			force: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			from: { type: "string" },
			to: { type: "string" },
			truncate: { type: "boolean", default: false },
			message: { type: "string" },
			style: { type: "string" },
			title: { type: "string" },
			start: { type: "string" },
			end: { type: "string" },
			nodes: { type: "string" },
			all: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	const [group, command, first, second] = positionals;

	if (values.help || !group) {
		process.stdout.write(`${USAGE}\n`);
		process.exit(values.help ? 0 : 2);
	}

	if (group === "db" && command !== "failback" && command !== "switchover") {
		process.exit(await runDbCommand(command, values));
	}

	const url = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set", 2);
	const key =
		process.env.CREDENTIAL_ENCRYPTION_KEY ?? fail("CREDENTIAL_ENCRYPTION_KEY is not set", 2);
	const database = openDatabase({ url, maxConnections: 2 });
	const bus = await openOrderBus(url, database);
	const { primary, tables } = database;
	const admin: Admin = {
		registry: createRegistry(database),
		config: createConfigStore(database, await SecretBox.fromBase64(key)),
		sendOrder: async (order) => {
			if (!bus) {
				throw new RefusedError("orders need the Postgres setup with a running main node");
			}

			return sendOrder(bus, order);
		},
		setRolloutPaused: async (paused) => {
			const updatedAt = new Date().toISOString();

			await primary
				.insert(tables.clusterState)
				.values({ id: CLUSTER_STATE_ID, rolloutPaused: paused, updatedAt })
				.onConflictDoUpdate({
					target: tables.clusterState.id,
					set: { rolloutPaused: paused, updatedAt },
				});
		},
		readFile: async (path) => {
			if (path !== "-") {
				return readFile(path, "utf8");
			}

			const chunks: Buffer[] = [];

			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

			return Buffer.concat(chunks).toString("utf8");
		},
		now: () => new Date(),
		print: (line) => process.stdout.write(`${line}\n`),
	};

	const statusDeps = async (): Promise<StatusDeps & { close: () => void }> => {
		const shared = await admin.config.values();
		const setting = (key: string) => process.env[key] || shared[key];
		const url = setting("KUMA_URL");
		const username = setting("KUMA_USERNAME");
		const password = setting("KUMA_PASSWORD");

		if (!url || !username || !password) {
			throw new RefusedError("set KUMA_URL, KUMA_USERNAME and KUMA_PASSWORD first");
		}

		const kuma = connectKuma({
			url,
			username,
			password,
			log: { info: () => {}, warn: () => {} },
		});

		return {
			kuma,
			slug: setting("KUMA_STATUS_SLUG") ?? "colibri",
			nodes: () => admin.registry.list(),
			print: admin.print,
			now: admin.now,
			close: () => kuma.close(),
		};
	};

	const runStatus = async (): Promise<void> => {
		const deps = await statusDeps();
		const [, area, action, ...rest] = positionals;
		const id = (value: string | undefined) => {
			const parsed = Number(required(value, "<id>"));

			if (!Number.isInteger(parsed)) throw new UsageError(`${value} isn't an ID`);

			return parsed;
		};
		const text = (parts: string[], name: string) => required(parts.join(" ") || undefined, name);

		try {
			switch (`${area ?? ""} ${action ?? ""}`.trim()) {
				case "":
					return await runStatusTui(
						{ ...deps, print: (line) => clack.log.info(line) },
						clack as unknown as Prompts,
					);
				case "incident list":
					return await listIncidents(deps, values.all);
				case "incident create":
					await createIncident(deps, {
						title: text(rest, "<title>"),
						...(values.message ? { message: values.message } : {}),
						...(values.style ? { style: values.style } : {}),
					});
					return;
				case "incident update":
					await updateIncident(deps, {
						id: id(rest[0]),
						message: text(rest.slice(1), "<message>"),
						...(values.title ? { title: values.title } : {}),
						...(values.style ? { style: values.style } : {}),
					});
					return;
				case "incident resolve":
					return await resolveIncident(deps, {
						id: id(rest[0]),
						...(rest.length > 1 ? { message: rest.slice(1).join(" ") } : {}),
					});
				case "maintenance list":
					return await listMaintenance(deps);
				case "maintenance schedule":
					await scheduleMaintenance(deps, {
						title: text(rest, "<title>"),
						start: required(values.start, "--start"),
						end: required(values.end, "--end"),
						...(values.nodes ? { nodes: values.nodes } : {}),
						...(values.message ? { message: values.message } : {}),
					});
					return;
				case "maintenance end":
					return await endMaintenance(deps, id(rest[0]));
				default:
					throw new UsageError(`unknown command: ${positionals.join(" ")}`);
			}
		} catch (error) {
			if (error instanceof StatusUsageError) throw new UsageError(error.message);

			throw error;
		} finally {
			deps.close();
		}
	};

	const run = async (): Promise<void> => {
		if (group === "status" && command !== "deploy") {
			return runStatus();
		}

		switch (`${group} ${command ?? ""}`.trim()) {
			case "node list":
				return nodeList(admin);
			case "node add":
				return nodeAdd(admin, {
					id: required(first, "<id>"),
					region: required(values.region, "--region"),
					roles: required(values.roles, "--roles"),
					...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
					...(values.ip ? { ip: values.ip } : {}),
					...(values.workers ? { workers: values.workers } : {}),
				});
			case "node shutdown":
				return nodeShutdown(admin, {
					id: required(first, "<id>"),
					maintenance: values.maintenance,
					retire: values.retire,
					...(values.grace ? { grace: values.grace } : {}),
					force: values.force,
				});
			case "node resume":
				return nodeResume(admin, required(first, "<id>"));
			case "monitoring deploy":
				return monitoringDeploy(admin, required(first, "<node>"));
			case "status deploy":
				return statusDeploy(admin, required(first, "<node>"));
			case "node recover":
				return nodeRecover(admin, required(first, "<id>"));
			case "node remove":
				return nodeRemove(admin, { id: required(first, "<id>"), force: values.force });
			case "db failback":
				return dbFailback(admin, first);
			case "db switchover":
				return dbSwitchover(admin, required(first, "<node>"));
			case "rollout pause":
				return rollout(admin, true);
			case "rollout resume":
				return rollout(admin, false);
			case "config list":
				return configList(admin);
			case "config set":
				return configSet(admin, required(first, "<KEY>"), required(second, "<value>"));
			case "config unset":
				return configUnset(admin, required(first, "<KEY>"));
			case "config import":
				return configImport(admin, { file: required(first, "<file>"), dryRun: values["dry-run"] });
			default:
				throw new UsageError(`unknown command: ${positionals.join(" ")}`);
		}
	};

	let code = 0;

	try {
		await run();
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${USAGE}\n`);
			code = 2;
		} else if (error instanceof RefusedError) {
			process.stderr.write(`${error.message}\n`);
			code = 1;
		} else {
			throw error;
		}
	} finally {
		await bus?.close();
		await database.close();
	}

	process.exit(code);
};

await main();
