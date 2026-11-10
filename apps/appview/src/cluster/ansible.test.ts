import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnsibleRunner } from "./ansible.js";

let directory: string;
let command: string;
let record: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "colibri-runner-"));
	command = join(directory, "fake-ansible-playbook");
	record = join(directory, "calls");
	writeFileSync(
		command,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "${record}"`,
			`for arg in "$@"; do case "$arg" in @*) cat "\${arg#@}" >> "${record}"; printf "\\n" >> "${record}";; esac; done`,
			'echo "PLAY [x]"',
			'echo "failed=0" 1>&2',
			'case "$*" in *remove.yml*) exit 2;; esac',
			"sleep 0.05",
		].join("\n"),
	);
	chmodSync(command, 0o755);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const runner = () => {
	return createAnsibleRunner({
		directory,
		user: "root",
		keyFile: "/run/secrets/key",
		log: { info: vi.fn(), warn: vi.fn() },
		command,
		knownHostsDirectory: join(directory, "ssh"),
	});
};

describe("createAnsibleRunner", () => {
	it("runs a playbook against one host with the variables in a file it removes after", async () => {
		const result = await runner().run({
			playbook: "bootstrap",
			host: "203.0.113.7",
			vars: { node_id: "eu-2" },
		});

		expect(result).toMatchObject({ ok: true, code: 0, tail: ["PLAY [x]", "failed=0"] });

		const calls = readFileSync(record, "utf8");

		expect(calls).toContain("-i 203.0.113.7, -u root --private-key /run/secrets/key -e @");
		expect(calls).toContain(join(directory, "playbooks", "bootstrap.yml"));
		expect(calls).toContain('{"node_id":"eu-2"}');
	});

	it("hands ssh a private copy of the key", async () => {
		const key = join(directory, "mounted-key");

		writeFileSync(key, "KEY", { mode: 0o644 });

		const ansible = createAnsibleRunner({
			directory,
			user: "root",
			keyFile: key,
			log: { info: vi.fn(), warn: vi.fn() },
			command,
			knownHostsDirectory: join(directory, "ssh"),
		});

		await ansible.run({ playbook: "recover", host: "x", vars: {} });

		const call = readFileSync(record, "utf8").split("\n")[0] ?? "";

		expect(call).toMatch(/--private-key \S+colibri-ansible-\S+\/id /);
	});

	it("reports a failed playbook", async () => {
		expect(await runner().run({ playbook: "remove", host: "eu-2", vars: {} })).toMatchObject({
			ok: false,
			code: 2,
		});
	});

	it("runs one playbook at a time", async () => {
		const ansible = runner();
		const first = ansible.run({ playbook: "update", host: "a", vars: {} });
		const second = ansible.run({ playbook: "update", host: "b", vars: {} });

		expect(ansible.busy).toBe(true);

		await Promise.all([first, second]);

		const hosts = readFileSync(record, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("-i"))
			.map((line) => line.split(" ")[1]);

		expect(hosts).toEqual(["a,", "b,"]);
		expect(ansible.busy).toBe(false);
	});

	it("reports a missing ansible-playbook", async () => {
		const missing = createAnsibleRunner({
			directory,
			user: "root",
			keyFile: "k",
			log: { info: vi.fn(), warn: vi.fn() },
			command: join(directory, "nope"),
		});

		expect(await missing.run({ playbook: "recover", host: "x", vars: {} })).toMatchObject({
			ok: false,
			code: null,
		});
	});
});
