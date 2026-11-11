import {
	appliedMigrations,
	type Database,
	knownMigrations,
	runMigrations,
	type Schema,
} from "@colibri-social/appview-db";
import { getTableColumns, sql } from "drizzle-orm";

export const MAX_PARAMETERS = 30_000;

export type CopyOptions = {
	source: Database;
	target: Database;
	truncate?: boolean;
	print: (line: string) => void;
};

export type TableCopy = {
	table: string;
	rows: number;
};

export class CopyRefusedError extends Error {}

type AnyTable = Schema[keyof Schema];

const tableName = (table: AnyTable): string => {
	return (table as unknown as { [key: symbol]: string })[Symbol.for("drizzle:Name")] ?? "";
};

const countRows = async (database: Database, table: AnyTable): Promise<number> => {
	const [row] = await (
		database.primary as unknown as {
			select: (fields: unknown) => { from: (table: AnyTable) => Promise<{ count: number }[]> };
		}
	)
		.select({ count: sql<number>`count(*)` })
		.from(table);

	return Number(row?.count ?? 0);
};

const readBatch = async (
	database: Database,
	table: AnyTable,
	limit: number,
	offset: number,
): Promise<Record<string, unknown>[]> => {
	return (
		database.primary as unknown as {
			select: () => {
				from: (table: AnyTable) => {
					orderBy: (order: unknown) => {
						limit: (limit: number) => {
							offset: (offset: number) => Promise<Record<string, unknown>[]>;
						};
					};
				};
			};
		}
	)
		.select()
		.from(table)
		.orderBy(sql`rowid`)
		.limit(limit)
		.offset(offset);
};

const insertBatch = async (
	database: Database,
	table: AnyTable,
	rows: Record<string, unknown>[],
): Promise<void> => {
	await (
		database.primary as unknown as {
			insert: (table: AnyTable) => {
				values: (rows: Record<string, unknown>[]) => Promise<unknown>;
			};
		}
	)
		.insert(table)
		.values(rows);
};

const truncateAll = async (database: Database, tables: AnyTable[]): Promise<void> => {
	const names = tables.map((table) => `"${tableName(table)}"`).join(", ");

	await (database.primary as unknown as { execute: (query: unknown) => Promise<unknown> }).execute(
		sql.raw(`truncate table ${names}`),
	);
};

export const copyDatabase = async (options: CopyOptions): Promise<TableCopy[]> => {
	const { source, target, print } = options;

	if (source.dialect !== "sqlite") {
		throw new CopyRefusedError("the source has to be the libSQL database");
	}

	if (target.dialect !== "postgres") {
		throw new CopyRefusedError("the target has to be a Postgres database");
	}

	const applied = await appliedMigrations(source);

	if (applied !== knownMigrations("sqlite")) {
		throw new CopyRefusedError(
			`the libSQL database has ${applied} of ${knownMigrations("sqlite")} migrations. Start the AppView once on this version against it, stop it, then copy`,
		);
	}

	await runMigrations(target);

	const keys = Object.keys(source.tables).sort() as (keyof Schema)[];
	const pairs = keys.map((key) => ({
		key,
		from: source.tables[key] as AnyTable,
		to: target.tables[key] as AnyTable,
	}));
	const filled: string[] = [];

	for (const pair of pairs) {
		if ((await countRows(target, pair.to)) > 0) filled.push(tableName(pair.to));
	}

	if (filled.length > 0 && !options.truncate) {
		throw new CopyRefusedError(
			`the target already has rows in ${filled.join(", ")}. Pass --truncate to empty it first`,
		);
	}

	if (filled.length > 0) {
		await truncateAll(
			target,
			pairs.map((pair) => pair.to),
		);
		print(`Emptied ${filled.length} tables in the target.`);
	}

	const copied: TableCopy[] = [];

	for (const pair of pairs) {
		const name = tableName(pair.from);
		const total = await countRows(source, pair.from);
		const columns = Object.keys(getTableColumns(pair.from as never)).length;
		const batch = Math.max(1, Math.floor(MAX_PARAMETERS / Math.max(columns, 1)));

		for (let offset = 0; offset < total; offset += batch) {
			const rows = await readBatch(source, pair.from, batch, offset);

			if (rows.length > 0) await insertBatch(target, pair.to, rows);
		}

		const written = await countRows(target, pair.to);

		if (written !== total) {
			throw new CopyRefusedError(`${name} has ${total} rows in libSQL but ${written} in Postgres`);
		}

		copied.push({ table: name, rows: total });
		print(`${name.padEnd(32)} ${String(total).padStart(9)}`);
	}

	return copied;
};
