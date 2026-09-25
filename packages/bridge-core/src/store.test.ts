import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeStore, MemoryBridgeStore, SqliteBridgeStore } from "./store.js";

const directories: string[] = [];

const sqlite = (): BridgeStore => {
	const directory = mkdtempSync(join(tmpdir(), "bridge-store-"));
	directories.push(directory);
	return new SqliteBridgeStore(join(directory, "bridge.sqlite"));
};

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe.each([
	["memory", () => new MemoryBridgeStore()],
	["sqlite", sqlite],
])("%s store", (_, create) => {
	it("finds a mapping from either side and forgets it on removal", async () => {
		const store = create();
		const mapping = {
			registration: "community registration",
			channel: "at://channel",
			kind: "message" as const,
			remoteId: "remote-1",
			rkey: "at://channel did:plc:x 3lkmsg",
			origin: "remote" as const,
		};
		await store.put(mapping);

		expect(await store.byRemote({ ...mapping })).toEqual(mapping);
		expect(await store.byColibri({ ...mapping })).toEqual(mapping);

		await store.remove(mapping);
		expect(await store.byRemote({ ...mapping })).toBeNull();
		await store.close();
	});

	it("counts each reactor once", async () => {
		const store = create();

		expect(await store.addReactor("key", "alice")).toBe(1);
		expect(await store.addReactor("key", "alice")).toBe(1);
		expect(await store.addReactor("key", "bob")).toBe(2);
		expect(await store.removeReactor("key", "alice")).toBe(1);
		expect(await store.removeReactor("key", "bob")).toBe(0);
		await store.close();
	});

	it("keeps backfill progress by key", async () => {
		const store = create();
		const progress = {
			state: "running" as const,
			from: "2026-09-01T00:00:00.000Z",
			until: "2026-09-24T00:00:00.000Z",
			cursor: "remote-9",
			thread: { id: "thread-1", cursor: "remote-3" },
			threadsDone: ["thread-0"],
			imported: 12,
			reached: "2026-09-10T00:00:00.000Z",
		};

		expect(await store.backfill("portal 1")).toBeNull();
		await store.putBackfill("portal 1", progress);
		expect(await store.backfill("portal 1")).toEqual(progress);
		await store.putBackfill("portal 1", { ...progress, state: "done" });
		expect(await store.backfill("portal 1")).toMatchObject({ state: "done" });
		await store.close();
	});

	it("keeps one avatar per remote author and forgets it on removal", async () => {
		const store = create();
		const blob = {
			$type: "blob" as const,
			ref: { $link: "bafyold" },
			mimeType: "image/png",
			size: 1,
		};

		await store.putAvatar("community registration", "alice", { url: "https://cdn/a.png", blob });
		await store.putAvatar("community registration", "alice", { url: "https://cdn/b.png", blob });
		expect(await store.avatar("community registration", "alice")).toEqual({
			url: "https://cdn/b.png",
			blob,
		});

		await store.removeAvatar("community registration", "alice");
		expect(await store.avatar("community registration", "alice")).toBeNull();
		await store.close();
	});

	it("purges everything one registration stored and leaves the others", async () => {
		const store = create();
		const blob = { $type: "blob" as const, ref: { $link: "bafy" }, mimeType: "image/png", size: 1 };
		for (const registration of ["community gone", "community kept"]) {
			await store.put({
				registration,
				channel: "at://channel",
				kind: "message",
				remoteId: "remote-1",
				rkey: "at://channel did:plc:x 3lkmsg",
				origin: "remote",
			});
			await store.putAvatar(registration, "alice", { url: "https://cdn/a.png", blob });
			await store.addReactor(`${registration} remote-1 👍`, "alice");
			await store.putBackfill(`${registration} at://channel 2026-09-24`, {
				state: "done",
				from: "2026-09-01T00:00:00.000Z",
				until: "2026-09-24T00:00:00.000Z",
				threadsDone: [],
				imported: 1,
			});
		}

		expect((await store.registrations()).sort()).toEqual(["community gone", "community kept"]);
		await store.purge("community gone");

		expect(await store.registrations()).toEqual(["community kept"]);
		expect(
			await store.byRemote({
				registration: "community gone",
				kind: "message",
				remoteId: "remote-1",
			}),
		).toBeNull();
		expect(await store.avatar("community gone", "alice")).toBeNull();
		expect(await store.backfill("community gone at://channel 2026-09-24")).toBeNull();
		expect(await store.addReactor("community gone remote-1 👍", "bob")).toBe(1);
		expect(await store.avatar("community kept", "alice")).not.toBeNull();
		expect(await store.addReactor("community kept remote-1 👍", "bob")).toBe(2);
		await store.close();
	});
});
