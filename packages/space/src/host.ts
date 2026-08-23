import { DidResolver, MemoryCache } from "@atproto/identity";
import { SpaceCredentialError } from "./errors.js";

export const SPACE_HOST_SERVICE_ID = "#atproto_space_host";
export const PDS_SERVICE_ID = "#atproto_pds";

export type SpaceHostResolver = {
	hostFor(authority: string): Promise<string>;
};

type DidService = { id: string; type: string; serviceEndpoint: string | Record<string, unknown> };

const endpointOf = (services: DidService[], id: string): string | null => {
	const match = services.find((service) => service.id === id || service.id.endsWith(id));
	if (!match || typeof match.serviceEndpoint !== "string") return null;
	return match.serviceEndpoint.replace(/\/$/, "");
};

export type DidDocumentHostResolverOptions = {
	plcUrl?: string;
	resolver?: DidResolver;
};

export class DidDocumentSpaceHostResolver implements SpaceHostResolver {
	private readonly resolver: DidResolver;

	constructor(options: DidDocumentHostResolverOptions = {}) {
		this.resolver =
			options.resolver ??
			new DidResolver({
				plcUrl: options.plcUrl ?? "https://plc.directory",
				didCache: new MemoryCache(60 * 60 * 1000, 24 * 60 * 60 * 1000),
			});
	}

	async hostFor(authority: string): Promise<string> {
		const document = await this.resolver.resolve(authority).catch((cause) => {
			throw new SpaceCredentialError(authority, "hostUnresolvable", `cannot resolve ${authority}`, {
				cause,
			});
		});
		const services = (document?.service ?? []) as DidService[];
		const endpoint =
			endpointOf(services, SPACE_HOST_SERVICE_ID) ?? endpointOf(services, PDS_SERVICE_ID);
		if (!endpoint) {
			throw new SpaceCredentialError(
				authority,
				"hostUnresolvable",
				`${authority} publishes neither ${SPACE_HOST_SERVICE_ID} nor ${PDS_SERVICE_ID}`,
			);
		}
		return endpoint;
	}
}

export class StaticSpaceHostResolver implements SpaceHostResolver {
	constructor(private readonly hosts: Map<string, string>) {}

	async hostFor(authority: string): Promise<string> {
		const host = this.hosts.get(authority);
		if (!host) {
			throw new SpaceCredentialError(
				authority,
				"hostUnresolvable",
				`no host configured for ${authority}`,
			);
		}
		return host;
	}
}
