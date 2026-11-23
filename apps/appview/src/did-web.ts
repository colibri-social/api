import type { Secp256k1Keypair } from "@atproto/crypto";
import {
	buildDidDocument,
	type DidDocument,
	SERVICE_FRAGMENTS,
	serviceId,
} from "@colibri-social/identity";

export type DidDocuments = {
	primary: DidDocument;
	byHost: ReadonlyMap<string, DidDocument>;
};

export const serviceAuthAudience = (dids: readonly string[]): string[] => {
	return dids.flatMap((did) => [
		did,
		serviceId(did, SERVICE_FRAGMENTS.appview),
		serviceId(did, SERVICE_FRAGMENTS.syncer),
		serviceId(did, SERVICE_FRAGMENTS.notifs),
	]);
};

export const didWebHost = (did: string): string => {
	const [host = ""] = did.slice("did:web:".length).split(":");

	return decodeURIComponent(host).toLowerCase();
};

const endpointFor = (publicUrl: string, host: string): string => {
	const url = new URL(publicUrl);

	url.host = host;

	return url.origin;
};

export const buildDidDocuments = (
	options: { dids: readonly string[]; publicUrl: string },
	keypair: Secp256k1Keypair,
): DidDocuments => {
	const [primaryDid, ...aliases] = options.dids;

	if (!primaryDid) throw new Error("the AppView needs at least one did:web");

	const primary = buildDidDocument({ did: primaryDid, publicUrl: options.publicUrl }, keypair);
	const byHost = new Map([[didWebHost(primaryDid), primary]]);

	for (const alias of aliases) {
		const host = didWebHost(alias);

		if (byHost.has(host)) continue;

		const publicUrl = endpointFor(options.publicUrl, host);

		byHost.set(host, buildDidDocument({ did: alias, publicUrl }, keypair));
	}

	return { primary, byHost };
};

export const didDocumentForHost = (
	documents: DidDocuments,
	host: string | undefined,
): DidDocument => {
	if (!host) return documents.primary;

	return documents.byHost.get(host.trim().toLowerCase()) ?? documents.primary;
};
