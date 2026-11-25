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

const MIGRATION = "0045_space_uri_prefix";
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxx";
const LEGACY_CHANNEL = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/general`;
const CHANNEL = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/general`;
const LEGACY_SOURCE = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/other/${AUTHOR}/social.colibri.beta.message/3lksource001`;
const SOURCE = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/other/${AUTHOR}/social.colibri.beta.message/3lksource001`;
const EMOJI = `at://${AUTHOR}/blue.moji.collection.item/party`;
const NOW = "2026-11-25T12:00:00.000Z";

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

beforeEach(async () => {
	scratch = mkdtempSync(join(tmpdir(), "colibri-migrations-"));
	database = await openTestDatabase({ migrate: migrateBefore });
});

afterEach(async () => {
	await database.destroy();
	rmSync(scratch, { recursive: true, force: true });
});

describe(MIGRATION, () => {
	it("rewrites legacy space URIs in plain and JSON columns", async () => {
		const { db, tables } = database;

		await db.insert(tables.channels).values({
			space: LEGACY_CHANNEL,
			community: COMMUNITY,
			spaceType: "social.colibri.beta.channel.text",
			skey: "general",
			name: "general",
		});
		await db.insert(tables.messages).values({
			space: LEGACY_CHANNEL,
			author: AUTHOR,
			rkey: "3lkmessage001",
			community: COMMUNITY,
			text: `see ${LEGACY_CHANNEL} and ${EMOJI}`,
			forward: { source: { uri: LEGACY_SOURCE, space: LEGACY_CHANNEL }, emoji: EMOJI },
			createdAt: NOW,
			indexedAt: NOW,
		});

		await runMigrations(database);

		const [channel] = await db.select().from(tables.channels);
		const [message] = await db.select().from(tables.messages);

		expect(channel?.space).toBe(CHANNEL);
		expect(message?.space).toBe(CHANNEL);
		expect(message?.text).toBe(`see ${CHANNEL} and ${EMOJI}`);
		expect(message?.forward).toEqual({ source: { uri: SOURCE, space: CHANNEL }, emoji: EMOJI });
	});
});
