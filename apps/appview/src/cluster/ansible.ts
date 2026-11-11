import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../logger.js";

export const PLAYBOOKS = [
	"bootstrap",
	"update",
	"recover",
	"rejoin-replica",
	"remove",
	"uptime-kuma",
	"monitoring",
	"alloy",
	"database-hosts",
] as const;

export type Playbook = (typeof PLAYBOOKS)[number];

export type PlaybookRun = {
	playbook: Playbook;
	host: string;
	vars: Record<string, unknown>;
};

export type PlaybookResult = {
	ok: boolean;
	code: number | null;
	tail: string[];
};

export type AnsibleRunnerOptions = {
	directory: string;
	user: string;
	keyFile: string;
	log: Pick<Logger, "info" | "warn">;
	command?: string;
	tailLines?: number;
	knownHostsDirectory?: string;
};

export type AnsibleRunner = {
	run: (run: PlaybookRun) => Promise<PlaybookResult>;
	readonly busy: boolean;
};

export const createAnsibleRunner = (options: AnsibleRunnerOptions): AnsibleRunner => {
	let queue: Promise<unknown> = Promise.resolve();
	let running = 0;
	const tailLines = options.tailLines ?? 40;

	const execute = async ({ playbook, host, vars }: PlaybookRun): Promise<PlaybookResult> => {
		const scratch = await mkdtemp(join(tmpdir(), "colibri-ansible-"));
		const varsFile = join(scratch, "vars.json");
		const keyFile = join(scratch, "id");

		await writeFile(varsFile, JSON.stringify(vars), { mode: 0o600 });
		await mkdir(options.knownHostsDirectory ?? "/data/ssh", { recursive: true }).catch(() => {});

		const key = await readFile(options.keyFile).catch(() => null);

		if (key) {
			await writeFile(keyFile, key, { mode: 0o600 });
		}

		try {
			return await new Promise<PlaybookResult>((settle) => {
				const tail: string[] = [];
				const child = spawn(
					options.command ?? "ansible-playbook",
					[
						"-i",
						`${host},`,
						"-u",
						options.user,
						"--private-key",
						key ? keyFile : options.keyFile,
						"-e",
						`@${varsFile}`,
						resolve(options.directory, "playbooks", `${playbook}.yml`),
					],
					{
						cwd: options.directory,
						env: { ...process.env, ANSIBLE_CONFIG: resolve(options.directory, "ansible.cfg") },
					},
				);
				let pending = "";

				const take = (chunk: Buffer) => {
					pending += chunk.toString("utf8");

					const lines = pending.split("\n");

					pending = lines.pop() ?? "";

					for (const line of lines) {
						if (line.trim() === "") continue;

						options.log.info({ playbook, host, line }, "ansible.output");
						tail.push(line);

						if (tail.length > tailLines) tail.shift();
					}
				};

				child.stdout.on("data", take);
				child.stderr.on("data", take);
				child.on("error", (error) => {
					options.log.warn({ playbook, host, err: error }, "ansible.failedToStart");
					settle({ ok: false, code: null, tail: [...tail, error.message] });
				});
				child.on("close", (code) => {
					if (pending.trim() !== "") take(Buffer.from("\n"));

					options.log.info({ playbook, host, code }, "ansible.finished");
					settle({ ok: code === 0, code, tail });
				});
			});
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	};

	return {
		get busy() {
			return running > 0;
		},
		run: (run) => {
			running += 1;

			const next = queue.then(async () => {
				try {
					return await execute(run);
				} finally {
					running -= 1;
				}
			});

			queue = next.catch(() => {});

			return next;
		},
	};
};
