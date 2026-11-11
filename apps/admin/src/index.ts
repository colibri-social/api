#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	CLUSTER_STATE_ID,
	createConfigStore,
	createRegistry,
} from "@colibri-social/appview/cluster";
import { openDatabase } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import {
	type Admin,
	configImport,
	configList,
	configSet,
	configUnset,
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
import { openOrderBus, sendOrder } from "./orders.js";

const USAGE = `colibri-admin, run it inside the AppView container of the main node

  node list
  node add <id> --region <region> --roles <roles> [--public-url <url>]
                   [--ip <public ip> [--workers <n>]]
  node shutdown <id> --maintenance|--retire [--grace 15m] [--force]
  node resume <id>
  node recover <id>
  node remove <id> [--force]
  rollout pause|resume
  status deploy <node>
  monitoring deploy <node>
  config list
  config set <KEY> <value>
  config unset <KEY>
  config import <file|-> [--dry-run]`;

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
			help: { type: "boolean", default: false },
		},
	});
	const [group, command, first, second] = positionals;

	if (values.help || !group) {
		process.stdout.write(`${USAGE}\n`);
		process.exit(values.help ? 0 : 2);
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

	const run = async (): Promise<void> => {
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
