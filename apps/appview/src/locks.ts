import type { Database } from "@colibri-social/appview-db";
import { runMigrations } from "@colibri-social/appview-db";

export const MAIN_LOCK_KEY = 0x636f_6c01;

export const MIGRATION_LOCK_KEY = 0x636f_6c02;

const MIGRATION_RETRY_MS = 1_000;

export const migrateUnderLock = async (database: Database): Promise<void> => {
	const lock = database.advisoryLock(MIGRATION_LOCK_KEY);

	while (!(await lock.tryAcquire())) {
		await new Promise((resolve) => setTimeout(resolve, MIGRATION_RETRY_MS));
	}

	try {
		await runMigrations(database);
	} finally {
		await lock.release();
	}
};
