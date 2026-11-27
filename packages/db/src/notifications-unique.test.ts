import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { openTestDatabase, type TestDatabase } from "./testing.js";

type Journal = { entries: { tag: string }[] };

const MIGRATION = "0051_notifications_unique";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxx";
const RECIPIENT = "did:plc:recipientxxxxxxxxxxxxxxxxxxx";
const CHANNEL = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/general`;

let scratch: string;
let database: TestDatabase;

const migrateBefore = async (target: Database): Promise<void> => {
	const dialect = target.dialect === "postgres" ? "pg" : "sqlite";
	const source = fileURLToPath(new URL(`../migrations/${dialect}`, import.meta.url));
	const migrationsFolder = join(scratch, dialect);

	cpSync(source, migrationsFolder, { recursive: true });

	const journalPath = join(migrationsFolder, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
	const cut = journal.entries.findIndex((entry) => entry.tag === MIGRATION);

	writeFileSync(
		journalPath,
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }),
	);

	if (target.dialect === "postgres") {
		await migratePg(target.db as never, { migrationsFolder });
		return;
	}

	await migrateLibsql(target.db, { migrationsFolder });
};

const notification = (id: string, indexedAt: string, rkey = "3lkmessage001") => {
	return {
		id,
		recipient: RECIPIENT,
		kind: "mention" as const,
		community: COMMUNITY,
		space: CHANNEL,
		author: AUTHOR,
		messageAuthor: AUTHOR,
		messageRkey: rkey,
		indexedAt,
	};
};

beforeEach(async () => {
	scratch = mkdtempSync(join(tmpdir(), "colibri-migrations-"));
	database = await openTestDatabase({ migrate: migrateBefore });
});

afterEach(async () => {
	await database.destroy();
	rmSync(scratch, { recursive: true, force: true });
});

describe(MIGRATION, () => {
	it("keeps the earliest notification per message and refuses new duplicates", async () => {
		const { db, tables } = database;

		await db
			.insert(tables.notifications)
			.values([
				notification("b", "2026-11-27T12:00:02.000Z"),
				notification("a", "2026-11-27T12:00:01.000Z"),
				notification("c", "2026-11-27T12:00:01.000Z"),
				notification("d", "2026-11-27T12:00:03.000Z", "3lkmessage002"),
			]);

		await runMigrations(database);

		const rows = await db.select().from(tables.notifications);

		expect(rows.map((row) => row.id).sort()).toEqual(["a", "d"]);

		await expect(
			db.insert(tables.notifications).values(notification("e", "2026-11-27T12:00:04.000Z")),
		).rejects.toThrow();
	});
});
