import { openDatabase } from "@colibri-social/appview-db";
import { createLogger } from "../src/logger.js";
import { purgeFutureMessages } from "../src/purge-future-messages.js";

const log = createLogger({
	LOG_LEVEL: "info",
	NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
});

const url = process.env.DATABASE_URL;
if (!url) {
	log.error("purge.missingDatabaseUrl");
	process.exit(1);
}

const authToken = process.env.DATABASE_AUTH_TOKEN;
const database = openDatabase({ url, ...(authToken ? { authToken } : {}), maxConnections: 2 });

try {
	await purgeFutureMessages(database, {
		apply: process.argv.includes("--apply"),
		now: new Date(),
		log,
	});
} catch (error) {
	log.error({ err: error }, "purge.failed");
	process.exitCode = 1;
} finally {
	await database.close();
}
