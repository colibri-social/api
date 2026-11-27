import { COLLECTIONS, SELF } from "@colibri-social/lexicons";
import { XrpcError } from "@colibri-social/space";
import type { CommunityHost } from "./credentials.js";

type StoredHostRecord = { value?: { managingApp?: unknown } };

export const hostRecord = (managingApp: string, now: Date) => {
	return {
		$type: COLLECTIONS.communityHost,
		managingApp,
		updatedAt: now.toISOString(),
	};
};

export const writeHostRecord = (host: CommunityHost, managingApp: string, now: Date) => {
	return host.pds.putRepoRecord(host.session, {
		collection: COLLECTIONS.communityHost,
		rkey: SELF,
		record: hostRecord(managingApp, now),
	});
};

const publishedManagingApp = async (host: CommunityHost): Promise<string | undefined> => {
	try {
		const stored = await host.pds.getPublicRecord<StoredHostRecord>(
			host.session.did,
			COLLECTIONS.communityHost,
			SELF,
		);
		const managingApp = stored.value?.managingApp;

		return typeof managingApp === "string" ? managingApp : undefined;
	} catch (error) {
		if (error instanceof XrpcError && error.code === "RecordNotFound") return undefined;

		throw error;
	}
};

export const ensureHostRecord = async (
	host: CommunityHost,
	managingApp: string,
	now: Date = new Date(),
): Promise<boolean> => {
	if ((await publishedManagingApp(host)) === managingApp) return false;

	await writeHostRecord(host, managingApp, now);

	return true;
};
