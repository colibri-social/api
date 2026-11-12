import type { AdvisoryLock, Database } from "@colibri-social/appview-db";
import { acceptsWrites, runMigrations } from "@colibri-social/appview-db";
import { CLOCK_IDS, setClockId } from "@colibri-social/notifications";

export const MAIN_LOCK_KEY = 0x636f_6c01;

export const MIGRATION_LOCK_KEY = 0x636f_6c02;

export const CLOCK_LOCK_BASE = 0x636f_7000;

const MIGRATION_RETRY_MS = 1_000;

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
