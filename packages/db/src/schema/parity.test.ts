import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { schema as pgSchema } from "./pg.js";
import { schema as sqliteSchema } from "./sqlite.js";

type Shape = {
	table: string;
	columns: Array<{ name: string; notNull: boolean; primary: boolean; hasDefault: boolean }>;
	primaryKeys: string[][];
	indexes: Array<{ name: string | undefined; unique: boolean; columns: string[] }>;
};

const sortByName = <T extends { name: string | undefined }>(entries: T[]): T[] =>
	[...entries].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

const shapeOf = (
	config: ReturnType<typeof sqliteTableConfig> | ReturnType<typeof pgTableConfig>,
): Shape => ({
	table: config.name,
	columns: sortByName(
		config.columns.map((column) => ({
			name: column.name,
			notNull: column.notNull,
			primary: column.primary,
			hasDefault: column.hasDefault,
		})),
	),
	primaryKeys: config.primaryKeys.map((key) => key.columns.map((column) => column.name).sort()),
	indexes: sortByName(
		config.indexes.map((entry) => ({
			name: entry.config.name,
			unique: entry.config.unique,
			columns: (entry.config.columns as Array<{ name?: string }>).map((c) => c.name ?? "?"),
		})),
	),
});

describe("schema parity", () => {
	it("defines the same tables in both dialects", () => {
		expect(Object.keys(pgSchema).sort()).toEqual(Object.keys(sqliteSchema).sort());
	});

	for (const key of Object.keys(sqliteSchema) as Array<keyof typeof sqliteSchema>) {
		it(`${key} has the same shape in both dialects`, () => {
			const sqlite = shapeOf(sqliteTableConfig(sqliteSchema[key]));
			const postgres = shapeOf(pgTableConfig(pgSchema[key]));
			expect(postgres).toEqual(sqlite);
		});
	}
});
