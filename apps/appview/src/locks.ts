import type { AdvisoryLock, Database } from "@colibri-social/appview-db";
import {
	acceptsWrites,
	appliedMigrations,
	knownMigrations,
	runMigrations,
} from "@colibri-social/appview-db";
import { CLOCK_IDS, setClockId } from "@colibri-social/notifications";
import type { Logger } from "./logger.js";

export const MAIN_LOCK_KEY = 0x636f_6c01;

export const MIGRATION_LOCK_KEY = 0x636f_6c02;

export const CLOCK_LOCK_BASE = 0x636f_7000;

const MIGRATION_RETRY_MS = 1_000;

export const MIGRATION_WAIT_MS = 5_000;

export type WaitForMigrationsOptions = {
	applied?: () => Promise<number>;
	sleep?: (ms: number) => Promise<void>;
};

export const migrateUnderLock = async (database: Database): Promise<boolean> => {
	if (!(await acceptsWrites(database))) {
		return false;
	}

	const lock = database.advisoryLock(MIGRATION_LOCK_KEY);

	while (!(await lock.tryAcquire())) {
		await new Promise((resolve) => setTimeout(resolve, MIGRATION_RETRY_MS));
	}

	try {
		await runMigrations(database);
	} finally {
		await lock.release();
	}

	return true;
};

export const waitForMigrations = async (
	database: Database,
	log: Pick<Logger, "info">,
	options: WaitForMigrationsOptions = {},
): Promise<void> => {
	const known = knownMigrations(database.dialect);
	const applied = options.applied ?? (() => appliedMigrations(database));
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	for (;;) {
		const count = await applied();

		if (count >= known) {
			return;
		}

		log.info({ applied: count, known }, "migrations.waitingForMain");
		await sleep(MIGRATION_WAIT_MS);
	}
};

export const claimClockId = async (database: Database): Promise<AdvisoryLock | null> => {
	const start = Math.floor(Math.random() * CLOCK_IDS);

	for (let offset = 0; offset < CLOCK_IDS; offset += 1) {
		const clock = (start + offset) % CLOCK_IDS;
		const lock = database.advisoryLock(CLOCK_LOCK_BASE + clock);

		if (await lock.tryAcquire()) {
			setClockId(clock);

			return lock;
		}
	}

	return null;
};
