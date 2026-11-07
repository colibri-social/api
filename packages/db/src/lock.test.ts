import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdvisoryLock, grantedLock, holdLock, postgresAdvisoryLock } from "./lock.js";

const adminUrl = process.env.TEST_DATABASE_URL;

const KEY = 424_242;

describe("grantedLock", () => {
	it("is granted at once and released on demand", async () => {
		const lock = grantedLock();

		expect(await lock.tryAcquire()).toBe(true);
		expect(lock.held).toBe(true);

		await lock.release();

		expect(lock.held).toBe(false);
	});
});

describe("holdLock", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("calls onAcquired once the lock is held", async () => {
		const onAcquired = vi.fn();
		const holder = holdLock({ lock: grantedLock(), onAcquired, onLost: vi.fn() });

		await vi.waitFor(() => expect(onAcquired).toHaveBeenCalledTimes(1));
		await holder.stop();
	});

	it("retries until the lock frees up", async () => {
		vi.useFakeTimers();

		let free = false;
		const lock: AdvisoryLock = {
			held: false,
			tryAcquire: async () => free,
			release: async () => {},
			onLost: () => () => {},
		};
		const onAcquired = vi.fn();
		const holder = holdLock({ lock, retryMs: 1_000, onAcquired, onLost: vi.fn() });

		await vi.advanceTimersByTimeAsync(2_500);

		expect(onAcquired).not.toHaveBeenCalled();

		free = true;

		await vi.advanceTimersByTimeAsync(1_000);

		expect(onAcquired).toHaveBeenCalledTimes(1);

		await holder.stop();
	});

	it("keeps retrying when an attempt throws", async () => {
		vi.useFakeTimers();

		let calls = 0;
		const lock: AdvisoryLock = {
			held: false,
			tryAcquire: async () => {
				calls += 1;

				if (calls === 1) {
					throw new Error("connection refused");
				}

				return true;
			},
			release: async () => {},
			onLost: () => () => {},
		};
		const onAcquired = vi.fn();
		const onRetryFailed = vi.fn();
		const holder = holdLock({
			lock,
			retryMs: 1_000,
			onAcquired,
			onLost: vi.fn(),
			onRetryFailed,
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(onRetryFailed).toHaveBeenCalledTimes(1);
		expect(onAcquired).toHaveBeenCalledTimes(1);

		await holder.stop();
	});
});

describe.skipIf(!adminUrl)("postgresAdvisoryLock", () => {
	const locks: AdvisoryLock[] = [];

	const lockFor = () => {
		const lock = postgresAdvisoryLock(adminUrl as string, KEY);

		locks.push(lock);

		return lock;
	};

	afterEach(async () => {
		await Promise.all(locks.splice(0).map((lock) => lock.release()));
	});

	it("grants the lock to one holder at a time", async () => {
		const first = lockFor();
		const second = lockFor();

		expect(await first.tryAcquire()).toBe(true);
		expect(await second.tryAcquire()).toBe(false);

		await first.release();

		expect(await second.tryAcquire()).toBe(true);
	});

	it("reports a lost lock when its connection dies", async () => {
		const lock = lockFor();
		const lost = vi.fn();

		lock.onLost(lost);

		expect(await lock.tryAcquire()).toBe(true);

		const admin = new pg.Client({ connectionString: adminUrl });

		await admin.connect();
		await admin.query(
			"select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = $1",
			[KEY],
		);
		await admin.end();

		await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));

		expect(lock.held).toBe(false);
	});
});
