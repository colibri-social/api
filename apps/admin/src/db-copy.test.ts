import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Database,
	openDatabase,
	openTestDatabase,
	runMigrations,
	type TestDatabase,
} from "@colibri-social/appview-db";
import { getTableColumns } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopyRefusedError, copyDatabase } from "./db-copy.js";

let directory: string;
let source: Database;
let target: TestDatabase;

const AT = "2026-11-11T12:00:00.000Z";

const fill = async (database: Database) => {
	const { primary, tables } = database;

	await primary.insert(tables.nodes).values({
		id: "hel-1",
		region: "eu",
		roles: ["main", "api"],
		publicUrl: "https://hel-1.test",
		tailnetUrl: "http://hel-1:3100",
		state: "active",
		registeredAt: AT,
		heartbeatAt: AT,
	});
	await primary.insert(tables.clusterState).values({
		id: "cluster",
		mainNodeId: "hel-1",
		rolloutPaused: true,
		updatedAt: AT,
	});
	await primary.insert(tables.messages).values(
		Array.from({ length: 2_500 }, (_, index) => ({
			space: "at://did:plc:space/social.colibri.beta.channel.text/a",
			author: "did:plc:author",
			rkey: `3lk${String(index).padStart(10, "0")}`,
			community: "did:plc:space",
			text: `message ${index}`,
			facets: index % 2 === 0 ? [{ index: { byteStart: 0, byteEnd: 7 } }] : null,
			createdAt: AT,
			fromLegacyRepo: index % 3 === 0,
			indexedAt: AT,
		})),
	);
};

beforeEach(async (context) => {
	target = await openTestDatabase();

	if (target.dialect !== "postgres") {
		await target.destroy();
		context.skip();
	}

	directory = await mkdtemp(join(tmpdir(), "colibri-copy-"));
	source = openDatabase({ url: `file:${join(directory, "source.db")}` });
	await runMigrations(source);
});

afterEach(async () => {
	await source?.close();
	await target?.destroy().catch(() => undefined);
	await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe("copyDatabase", () => {
	it("copies every table with its JSON and boolean columns intact", async () => {
		await fill(source);

		const lines: string[] = [];
		const copied = await copyDatabase({ source, target, print: (line) => lines.push(line) });
		const { primary, tables } = target;
		const [node] = await primary.select().from(tables.nodes);
		const [state] = await primary.select().from(tables.clusterState);
		const messages = await primary.select().from(tables.messages);

		expect(copied.find((table) => table.table === "messages")?.rows).toBe(2_500);
		expect(node?.roles).toEqual(["main", "api"]);
		expect(state?.rolloutPaused).toBe(true);
		expect(messages).toHaveLength(2_500);
		expect(messages.filter((message) => message.fromLegacyRepo)).toHaveLength(834);
		expect(messages.find((message) => message.text === "message 0")?.facets).toEqual([
			{ index: { byteStart: 0, byteEnd: 7 } },
		]);
		expect(lines.some((line) => line.startsWith("messages"))).toBe(true);
	});

	it("copies a row of every table, column by column", async () => {
		const sample = (column: { dataType: string }): unknown => {
			if (column.dataType === "number") return 1;
			if (column.dataType === "boolean") return true;
			if (column.dataType === "json") return { probe: [1, "two"] };

			return AT;
		};
		const keys = Object.keys(source.tables) as (keyof typeof source.tables)[];

		for (const key of keys) {
			const table = source.tables[key];
			const row = Object.fromEntries(
				Object.entries(getTableColumns(table as never)).map(([name, column]) => [
					name,
					sample(column as { dataType: string }),
				]),
			);

			await (
				source.primary as unknown as {
					insert: (t: unknown) => { values: (r: unknown) => Promise<unknown> };
				}
			)
				.insert(table)
				.values(row);
		}

		const copied = await copyDatabase({ source, target, print: () => {} });

		expect(copied).toHaveLength(keys.length);
		expect(copied.every((table) => table.rows === 1)).toBe(true);

		for (const key of keys) {
			const table = target.tables[key];
			const [row] = await (
				target.primary as unknown as {
					select: () => { from: (t: unknown) => Promise<Record<string, unknown>[]> };
				}
			)
				.select()
				.from(table);

			for (const [name, column] of Object.entries(getTableColumns(table as never))) {
				const { dataType } = column as { dataType: string };

				if (dataType === "json" || dataType === "boolean" || dataType === "number") {
					expect({ table: key, column: name, value: row?.[name] }).toEqual({
						table: key,
						column: name,
						value: sample(column as { dataType: string }),
					});
				}
			}
		}
	});

	it("refuses a target with rows unless told to empty it", async () => {
		await fill(source);
		await copyDatabase({ source, target, print: () => {} });

		await expect(copyDatabase({ source, target, print: () => {} })).rejects.toThrow(/--truncate/);

		const copied = await copyDatabase({ source, target, truncate: true, print: () => {} });

		expect(copied.find((table) => table.table === "nodes")?.rows).toBe(1);
	});

	it("refuses a libSQL database that isn't fully migrated", async () => {
		const fresh = openDatabase({ url: `file:${join(directory, "fresh.db")}` });

		try {
			await expect(copyDatabase({ source: fresh, target, print: () => {} })).rejects.toThrow(
				CopyRefusedError,
			);
		} finally {
			await fresh.close();
		}
	});

	it("only copies from libSQL into Postgres", async () => {
		await expect(copyDatabase({ source: target, target, print: () => {} })).rejects.toThrow(
			/source has to be the libSQL database/,
		);
	});
});
