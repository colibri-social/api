import type { Database } from "@colibri-social/appview-db";
import { asc, eq } from "drizzle-orm";

export type ParkedHost = {
	host: string;
	reason: string;
	lastError: string | null;
	parkedAt: string;
};

export type ParkedHosts = {
	list: () => Promise<ParkedHost[]>;
	unpark: (host: string) => Promise<boolean>;
};

export const createParkedHosts = ({ primary, tables }: Database): ParkedHosts => {
	const table = tables.parkedRepoHosts;

	const list = async (): Promise<ParkedHost[]> => {
		return primary.select().from(table).orderBy(asc(table.host));
	};

	const unpark = async (host: string): Promise<boolean> => {
		const removed = await primary
			.delete(table)
			.where(eq(table.host, host))
			.returning({ host: table.host });

		return removed.length > 0;
	};

	return { list, unpark };
};
