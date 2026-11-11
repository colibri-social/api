import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FollowingPool, switchesPrimary } from "./following.js";
import type { HostProbe } from "./hosts.js";
import { openTestDatabase, type TestDatabase } from "./testing.js";

describe("switchesPrimary", () => {
	it("switches on read-only and connection errors only", () => {
		expect(switchesPrimary({ code: "25006" })).toBe(true);
		expect(switchesPrimary({ code: "ECONNREFUSED" })).toBe(true);
		expect(switchesPrimary(new Error("Connection terminated unexpectedly"))).toBe(true);
		expect(switchesPrimary({ code: "23505" })).toBe(false);
		expect(switchesPrimary(new Error("syntax error"))).toBe(false);
	});
});

describe("FollowingPool", () => {
	let first: TestDatabase;
	let second: TestDatabase;

	beforeEach(async (context) => {
		first = await openTestDatabase();

		if (first.dialect !== "postgres") {
			await first.destroy();
			context.skip();
		}

		second = await openTestDatabase();
	});

	afterEach(async () => {
		await first?.destroy().catch(() => undefined);
		await second?.destroy().catch(() => undefined);
	});

	it("sends queries to the writable host and follows it when it moves", async () => {
		const name = (url: string) => new URL(url).pathname.slice(1);
		let writable = name(first.url);
		const probe = async (url: string): Promise<HostProbe> => ({
			url,
			reachable: true,
			recovery: name(url) !== writable,
			readOnly: false,
			epoch: 1,
		});
		const pool = new FollowingPool({
			url: first.url,
			urls: [first.url, second.url],
			max: 2,
			probe,
			recheckMs: 20,
		});
		const switched: string[] = [];

		pool.onSwitch((url) => switched.push(name(url)));

		const database = async () =>
			(await pool.query<{ name: string }>("select current_database() as name")).rows[0]?.name;

		try {
			expect(await database()).toBe(name(first.url));

			writable = name(second.url);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(await database()).toBe(name(second.url));
			expect(switched).toEqual([name(second.url)]);

			const client = await pool.connect();

			try {
				expect((await client.query("select current_database() as name")).rows[0]?.name).toBe(
					name(second.url),
				);
			} finally {
				client.release();
			}
		} finally {
			await pool.end();
		}
	});
});
