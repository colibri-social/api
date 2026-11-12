import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";

export const MONITORING_FINGERPRINT_KEY = "monitoring.fingerprint";

export type MonitoringSyncOutcome = "unchanged" | "redeployed" | "skipped" | "failed";

export type MonitoringSyncDeps = {
	fingerprint: () => Promise<string>;
	stored: () => Promise<string | null>;
	store: (fingerprint: string) => Promise<void>;
	target: () => Promise<string | null>;
	deploy: (node: string) => Promise<boolean>;
	log: Pick<Logger, "info" | "warn">;
};

const filesUnder = async (path: string): Promise<string[]> => {
	const info = await stat(path).catch(() => null);

	if (!info) {
		return [];
	}

	if (info.isFile()) {
		return [path];
	}

	const entries = await readdir(path);
	const nested = await Promise.all(entries.map((entry) => filesUnder(join(path, entry))));

	return nested.flat();
};

const sortedJson = (value: Record<string, unknown>): string => {
	return JSON.stringify(
		Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
	);
};

export const monitoringFingerprint = async (
	paths: readonly string[],
	vars: Record<string, unknown>,
): Promise<string> => {
	const hash = createHash("sha256");
	const files = (await Promise.all(paths.map(filesUnder))).flat().sort();

	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}

	hash.update(sortedJson(vars));

	return hash.digest("hex");
};

export const createMonitoringSync = (deps: MonitoringSyncDeps) => {
	let running: Promise<MonitoringSyncOutcome> | null = null;

	const run = async (): Promise<MonitoringSyncOutcome> => {
		const target = await deps.target();

		if (!target) {
			return "skipped";
		}

		const [current, stored] = await Promise.all([deps.fingerprint(), deps.stored()]);

		if (current === stored) {
			return "unchanged";
		}

		deps.log.info({ node: target }, "monitoring.redeploying");

		if (!(await deps.deploy(target))) {
			deps.log.warn({ node: target }, "monitoring.redeployFailed");

			return "failed";
		}

		await deps.store(current);
		deps.log.info({ node: target }, "monitoring.redeployed");

		return "redeployed";
	};

	return {
		sync: (): Promise<MonitoringSyncOutcome> => {
			running ??= run()
				.catch((error: unknown) => {
					deps.log.warn({ err: error }, "monitoring.redeployFailed");

					return "failed" as const;
				})
				.finally(() => {
					running = null;
				});

			return running;
		},
	};
};
