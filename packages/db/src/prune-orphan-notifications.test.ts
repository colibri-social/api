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

const MIGRATION = "0043_prune_orphan_notifications";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxx";
const RECIPIENT = "did:plc:recipientxxxxxxxxxxxxxxxxxx";
const CHANNEL = "ats://did:plc:communityxxxxxxxxxxxxxxxxxxx/channel/3lkchannel001";
const THREAD = "ats://did:plc:communityxxxxxxxxxxxxxxxxxxx/thread/3lkthread001";
const NOW = "2026-11-16T12:00:00.000Z";

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

const insertMessage = (space: string, rkey: string) =>
	database.db.insert(database.tables.messages).values({
		space,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "hi",
		createdAt: NOW,
		indexedAt: NOW,
	});

const insertNotification = (id: string, space: string, messageAuthor: string, rkey: string) =>
	database.db.insert(database.tables.notifications).values({
		id,
		recipient: RECIPIENT,
		kind: "mention",
		community: COMMUNITY,
		space,
		author: messageAuthor,
		messageAuthor,
		messageRkey: rkey,
		indexedAt: NOW,
	});

const notificationIds = async () =>
	(await database.db.select().from(database.tables.notifications)).map((row) => row.id).sort();

beforeEach(async () => {
	scratch = mkdtempSync(join(tmpdir(), "colibri-migrations-"));
	database = await openTestDatabase({ migrate: migrateBefore });
});

afterEach(async () => {
	await database.destroy();
	rmSync(scratch, { recursive: true, force: true });
});

describe(MIGRATION, () => {
	it("deletes only the notifications whose message no longer exists", async () => {
		await insertMessage(CHANNEL, "3lkmessage001");
		await insertMessage(THREAD, "3lkmessage002");

		await insertNotification("channel", CHANNEL, AUTHOR, "3lkmessage001");
		await insertNotification("thread", THREAD, AUTHOR, "3lkmessage002");
		await insertNotification("deleted", CHANNEL, AUTHOR, "3lkmessage003");
		await insertNotification("other-space", THREAD, AUTHOR, "3lkmessage001");
		await insertNotification("other-author", CHANNEL, RECIPIENT, "3lkmessage001");

		await runMigrations(database);

		expect(await notificationIds()).toEqual(["channel", "thread"]);
	});
});
