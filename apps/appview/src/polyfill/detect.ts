import type { Database } from "@colibri-social/appview-db";
import { eq } from "drizzle-orm";

const DESCRIBE_METHOD = "community.lexicon.service.describe";
const PROBE_METHOD = "com.atproto.space.getDelegationToken";
const CONTROL_METHOD = "com.atproto.space.colibriProbeControl";
const PROBE_QUERY = "?space=colibri-spaces-probe";
const PROBE_TIMEOUT_MS = 8_000;

export const SUPPORTED_TTL_MS = 24 * 60 * 60_000;
export const UNSUPPORTED_TTL_MS = 60 * 60_000;

export type Fetch = typeof globalThis.fetch;

export type SupportProbe = (pds: string) => Promise<boolean | undefined>;

type ProbeAnswer = {
	status: number;
	error: string | undefined;
	message: string | undefined;
};

const methodUrl = (pds: string, method: string, query = ""): string => {
	return `${new URL(`/xrpc/${method}`, pds).toString()}${query}`;
};

const readJson = async (res: Response): Promise<unknown> => {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
};

const readString = (value: unknown): string | undefined => {
	return typeof value === "string" ? value : undefined;
};

const isServerFailure = (status: number): boolean => {
	return status >= 500 && status !== 501;
};

export const spacesSupportProbe = (fetch: Fetch = globalThis.fetch): SupportProbe => {
	const request = (url: string) => {
		return fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	};

	const describedMethods = async (pds: string): Promise<string[] | undefined> => {
		let res: Response;
		try {
			res = await request(methodUrl(pds, DESCRIBE_METHOD));
		} catch {
			return undefined;
		}
		if (!res.ok) return undefined;

		const methods = ((await readJson(res)) as { methods?: unknown } | null)?.methods;
		if (!Array.isArray(methods)) return undefined;

		return methods.flatMap((entry) => {
			const value = readString((entry as { value?: unknown } | null)?.value);

			return value === undefined ? [] : [value];
		});
	};

	const probe = async (url: string): Promise<ProbeAnswer> => {
		const res = await request(url);
		const body = (await readJson(res)) as { error?: unknown; message?: unknown } | null;

		return {
			status: res.status,
			error: readString(body?.error),
			message: readString(body?.message),
		};
	};

	return async (pds) => {
		const methods = await describedMethods(pds);
		if (methods !== undefined) return methods.includes(PROBE_METHOD);

		let real: ProbeAnswer;
		let control: ProbeAnswer;
		try {
			[real, control] = await Promise.all([
				probe(methodUrl(pds, PROBE_METHOD, PROBE_QUERY)),
				probe(methodUrl(pds, CONTROL_METHOD, PROBE_QUERY)),
			]);
		} catch {
			return undefined;
		}

		if (isServerFailure(real.status) || isServerFailure(control.status)) return undefined;

		return (
			real.error === "InvalidSpaceRef" ||
			real.message?.includes(`${PROBE_METHOD} params`) === true ||
			real.status !== control.status ||
			real.error !== control.error
		);
	};
};

export type SpacesSupportOptions = {
	database: Pick<Database, "primary" | "tables">;
	probe: SupportProbe;
	now?: () => Date;
};

export type SpacesSupport = {
	check(pds: string, options?: { fresh?: boolean }): Promise<boolean | undefined>;
};

export const spacesSupport = ({
	database,
	probe,
	now = () => new Date(),
}: SpacesSupportOptions) => {
	const { primary: db, tables } = database;
	const table = tables.polyfillPdsSupport;

	const cached = async (pds: string): Promise<boolean | undefined> => {
		const [row] = await db.select().from(table).where(eq(table.pdsEndpoint, pds)).limit(1);
		if (!row) return undefined;

		const age = now().getTime() - Date.parse(row.checkedAt);
		const ttl = row.supported ? SUPPORTED_TTL_MS : UNSUPPORTED_TTL_MS;

		return Number.isFinite(age) && age < ttl ? row.supported : undefined;
	};

	const support: SpacesSupport = {
		check: async (pds, options = {}) => {
			if (!options.fresh) {
				const hit = await cached(pds);
				if (hit !== undefined) return hit;
			}

			const supported = await probe(pds);
			if (supported === undefined) return undefined;

			const row = { pdsEndpoint: pds, supported, checkedAt: now().toISOString() };

			await db
				.insert(table)
				.values(row)
				.onConflictDoUpdate({ target: table.pdsEndpoint, set: row });

			return supported;
		},
	};

	return support;
};
