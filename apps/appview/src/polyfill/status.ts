import type { HostMode } from "./host-mode.js";
import { fallBackToPolyfill, type MigrationProgress, migrationProgress } from "./migration.js";
import { loadActor, nowOf, type PolyfillDeps, saveActor } from "./state.js";

export type PolyfillStatus = {
	mode: HostMode;
	pdsSupportsSpaces: boolean;
	migration?: MigrationProgress;
};

export const getPolyfillStatus = async (
	deps: PolyfillDeps,
	did: string,
): Promise<PolyfillStatus> => {
	const tables = { db: deps.database.primary, tables: deps.database.tables };
	const stored = await loadActor(tables, did);
	const pds = await deps.pdsOf(did);
	const supported = pds ? await deps.support.check(pds) : undefined;
	let mode: HostMode = stored?.mode ?? "native";

	if (supported === false && mode === "native") {
		await fallBackToPolyfill(deps, did, pds);
		mode = "polyfill";
	} else if (stored && supported !== undefined) {
		await saveActor(tables, { ...stored, pds, pdsSupportsSpaces: supported }, nowOf(deps));
	}

	return {
		mode,
		pdsSupportsSpaces: supported ?? stored?.pdsSupportsSpaces ?? false,
		...(mode === "migrating" ? { migration: await migrationProgress(deps, did) } : {}),
	};
};
