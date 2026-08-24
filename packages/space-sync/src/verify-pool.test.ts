import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdvanceRequest } from "./verify-pool.js";
import { inlineVerifier, VerifierPool } from "./verify-pool.js";

const FAKE_WORKER = `
import { parentPort, threadId } from "node:worker_threads";

parentPort.on("message", ({ id, job }) => {
	if (job.author === "die") process.exit(1);
	if (job.author === "throw") {
		parentPort.postMessage({ id, failure: "the worker refused" });
		return;
	}
	parentPort.postMessage({
		id,
		result: { setHashBase64: String(threadId), authentic: true, matches: true },
	});
});
`;

const request = (author: string): AdvanceRequest => ({
	space: "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchan",
	author,
	didKey: "did:key:z",
	setHashBase64: null,
	ops: [],
	commit: null,
});

let entry: URL;
let pool: VerifierPool | null = null;

beforeAll(async () => {
	const directory = await mkdtemp(join(tmpdir(), "verify-pool-"));
	const file = join(directory, "fake-worker.mjs");
	await writeFile(file, FAKE_WORKER, "utf8");
	entry = pathToFileURL(file);
});

afterEach(async () => {
	await pool?.close();
	pool = null;
});

describe("inlineVerifier", () => {
	it("folds an empty op list into the state it started from", async () => {
		const result = await inlineVerifier().advance(request("did:plc:alice"));

		expect(result).toMatchObject({ authentic: true, matches: true });
		expect(result.setHashBase64).toBeTypeOf("string");
	});
});

describe("VerifierPool", () => {
	it("spreads jobs across its workers", async () => {
		pool = new VerifierPool({ size: 2, entry });

		const first = await pool.advance(request("did:plc:alice"));
		const second = await pool.advance(request("did:plc:bob"));

		expect(new Set([first.setHashBase64, second.setHashBase64]).size).toBe(2);
	});

	it("surfaces a failure the worker reports", async () => {
		pool = new VerifierPool({ size: 1, entry });

		await expect(pool.advance(request("throw"))).rejects.toThrow("the worker refused");
	});

	it("replaces a worker that died and keeps taking jobs", async () => {
		const died: Error[] = [];
		pool = new VerifierPool({ size: 1, entry, onWorkerDied: (error) => void died.push(error) });

		await expect(pool.advance(request("die"))).rejects.toThrow();
		await vi.waitFor(() => expect(died).toHaveLength(1));

		expect(await pool.advance(request("did:plc:alice"))).toMatchObject({ authentic: true });
	});

	it("rejects jobs once it is closed", async () => {
		const closing = new VerifierPool({ size: 1, entry });
		await closing.close();

		await expect(closing.advance(request("did:plc:alice"))).rejects.toThrow("not accepting jobs");
	});
});
