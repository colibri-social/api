import { Database, PlcServer } from "@did-plc/server";

const port = Number(process.env.PORT ?? 2582);
const url = process.env.DATABASE_URL;

const openDatabase = async () => {
	if (!url) return Database.mock();
	const database = Database.postgres({ url });
	await database.migrateToLatestOrThrow();
	return database;
};

const server = PlcServer.create({ db: await openDatabase(), port });
await server.start();

const shutdown = () => void server.destroy().then(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
