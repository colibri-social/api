import { type AdvisoryLock, openTestDatabase } from "@colibri-social/appview-db";
import { describe, expect, it, vi } from "vitest";
import { createMainRole, type MainRole } from "./main-role.js";

const lockServer = () => {
	let owner: symbol | null = null;
	let main: string | null = null;

	const lock = (): AdvisoryLock => {
		const me = Symbol("holder");

		return {
			get held() {
				return owner === me;
			},
			tryAcquire: async () => {
				if (owner && owner !== me) return false;
				owner = me;

				return true;
			},
			release: async () => {
				if (owner === me) owner = null;
			},
			onLost: () => () => {},
		};
	};

	return {
		lock,
		get main() {
			return main;
		},
		claim: (id: string) => {
			main = id;
		},
	};
};

const until = async (check: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

const role = (server: ReturnType<typeof lockServer>, id: string, events: string[]) => {
	return createMainRole({
		lock: server.lock,
		canContend: () => true,
		mainNode: async () => server.main,
		onAcquired: async () => {
			server.claim(id);
			events.push(`${id} acquired`);
		},
		onReleasing: async () => {
			events.push(`${id} released`);
		},
		onLost: vi.fn(),
		log: { info: vi.fn(), warn: vi.fn() },
		retryMs: 10,
		pollMs: 5,
		timeoutMs: 500,
	});
};

describe("createMainRole", () => {
	it("hands main to the other contender and takes it back later", async () => {
		const server = lockServer();
		const events: string[] = [];
		const hel = role(server, "hel-1", events);
		const fsn = role(server, "fsn-1", events);

		hel.contend();
		await until(() => hel.held);
		fsn.contend();

		expect(await hel.yieldTo("fsn-1")).toBe(true);
		expect(fsn.held).toBe(true);
		expect(hel.held).toBe(false);

		expect(await fsn.yieldTo("hel-1")).toBe(true);
		expect(hel.held).toBe(true);
		expect(events).toEqual([
			"hel-1 acquired",
			"hel-1 released",
			"fsn-1 acquired",
			"fsn-1 released",
			"hel-1 acquired",
		]);

		await hel.stop();
		await fsn.stop();
	});

	it("takes main back when nobody else claims it in time", async () => {
		const server = lockServer();
		const events: string[] = [];
		const hel: MainRole = role(server, "hel-1", events);

		hel.contend();
		await until(() => hel.held);

		expect(await hel.yieldTo("fsn-1")).toBe(false);

		await until(() => hel.held);

		expect(hel.held).toBe(true);
		expect(events).toEqual(["hel-1 acquired", "hel-1 released", "hel-1 acquired"]);

		await hel.stop();
	});

	it("refuses to yield what it doesn't hold and stops contending while paused", async () => {
		const server = lockServer();
		const events: string[] = [];
		const hel = role(server, "hel-1", events);
		const fsn = role(server, "fsn-1", events);

		hel.contend();
		await until(() => hel.held);
		fsn.contend();

		expect(await fsn.yieldTo("hel-1")).toBe(false);

		await fsn.pause();
		await hel.stop();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(fsn.held).toBe(false);
		expect(events).toEqual(["hel-1 acquired", "hel-1 released"]);
	});
});

describe("createMainRole on Postgres", () => {
	it("moves the main lock between two connections", async (context) => {
		const database = await openTestDatabase();

		if (database.dialect !== "postgres") {
			await database.destroy();
			context.skip();
		}

		let main: string | null = null;
		const make = (id: string) => {
			return createMainRole({
				lock: () => database.advisoryLock(0x636f_6cff),
				canContend: () => true,
				mainNode: async () => main,
				onAcquired: async () => {
					main = id;
				},
				onReleasing: async () => {},
				onLost: vi.fn(),
				log: { info: vi.fn(), warn: vi.fn() },
				retryMs: 20,
				pollMs: 10,
				timeoutMs: 2_000,
			});
		};
		const hel = make("hel-1");
		const fsn = make("fsn-1");

		try {
			hel.contend();
			await until(() => hel.held);
			fsn.contend();
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(fsn.held).toBe(false);
			expect(await hel.yieldTo("fsn-1")).toBe(true);
			expect(fsn.held).toBe(true);
			expect(await fsn.yieldTo("hel-1")).toBe(true);
			expect(hel.held).toBe(true);
		} finally {
			await hel.stop();
			await fsn.stop();
			await database.destroy();
		}
	});
});

describe("createMainRole priority", () => {
	it("stays back while it may not acquire and takes over once invited", async () => {
		const server = lockServer();
		const events: string[] = [];
		let allowed = false;
		const hel = role(server, "hel-1", events);
		const fsn = createMainRole({
			lock: server.lock,
			canContend: () => true,
			mayAcquire: async () => allowed,
			mainNode: async () => server.main,
			onAcquired: async () => {
				server.claim("fsn-1");
				events.push("fsn-1 acquired");
			},
			onReleasing: async () => {},
			onLost: vi.fn(),
			log: { info: vi.fn(), warn: vi.fn() },
			retryMs: 10,
		});
		const invite = vi.fn((target: string) => {
			if (target === "fsn-1") allowed = true;
		});
		const helWithInvite = createMainRole({
			lock: server.lock,
			canContend: () => true,
			invite,
			mainNode: async () => server.main,
			onAcquired: async () => {
				server.claim("hel-1");
				events.push("hel-1 acquired");
			},
			onReleasing: async () => {},
			onLost: vi.fn(),
			log: { info: vi.fn(), warn: vi.fn() },
			retryMs: 10,
			pollMs: 5,
			timeoutMs: 500,
		});

		await hel.stop();
		fsn.contend();
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(fsn.held).toBe(false);

		helWithInvite.contend();
		await until(() => helWithInvite.held);

		expect(await helWithInvite.yieldTo("fsn-1")).toBe(true);
		expect(invite).toHaveBeenCalledWith("fsn-1");
		expect(fsn.held).toBe(true);

		await fsn.stop();
		await helWithInvite.stop();
	});
});
