import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownCredentials, saveNodeCredentials } from "./node-secret.js";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "colibri-secret-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("ownCredentials", () => {
	it("issues a secret on the first start and keeps it after that", async () => {
		const file = join(directory, "node-secret");
		const issue = vi.fn(async () => "s1");
		const verify = vi.fn(async (_id: string, secret: string) => secret === "s1");

		expect(await ownCredentials({ file, id: "hel-1", verify, issue })).toEqual({
			id: "hel-1",
			secret: "s1",
		});
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id: "hel-1", secret: "s1" });
		expect(await ownCredentials({ file, id: "hel-1", verify, issue })).toEqual({
			id: "hel-1",
			secret: "s1",
		});
		expect(issue).toHaveBeenCalledTimes(1);
	});

	it("issues a new secret when the stored one no longer verifies", async () => {
		const file = join(directory, "node-secret");

		await saveNodeCredentials(file, { id: "hel-1", secret: "old" });

		const credentials = await ownCredentials({
			file,
			id: "hel-1",
			verify: async () => false,
			issue: async () => "new",
		});

		expect(credentials.secret).toBe("new");
	});
});
