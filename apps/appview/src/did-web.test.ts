import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
	type IdentityResolver,
	mintServiceAuth,
	ServiceAuth,
	ServiceAuthError,
} from "@colibri-social/identity";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import {
	buildDidDocuments,
	type DidDocuments,
	didDocumentForHost,
	didWebHost,
	serviceAuthAudience,
} from "./did-web.js";
import { createDrainState } from "./drain.js";
import { createAppServer } from "./server.js";

const PRIMARY = "did:web:api.colibri.test";
const ALIAS = "did:web:spaces-api.colibri.test";
const PUBLIC_URL = "https://api.colibri.test";
const CALLER = "did:web:user.example";

let keypair: Secp256k1Keypair;

beforeAll(async () => {
	keypair = await Secp256k1Keypair.create({ exportable: true });
});

describe("didWebHost", () => {
	it("decodes the port and drops any path", () => {
		expect(didWebHost("did:web:API.colibri.test")).toBe("api.colibri.test");
		expect(didWebHost("did:web:localhost%3A3000")).toBe("localhost:3000");
		expect(didWebHost("did:web:example.com:appview")).toBe("example.com");
	});
});

describe("service auth audience", () => {
	const resolver = {
		signingKeyFor: async () => keypair.did(),
	} as unknown as IdentityResolver;

	const authFor = (dids: string[]) => {
		return new ServiceAuth({
			audience: serviceAuthAudience(dids),
			maxLifetimeSeconds: 300,
			resolver,
		});
	};

	const mint = (audience: string) => {
		return mintServiceAuth({
			issuer: CALLER,
			audience,
			lxm: null,
			keypair,
			lifetimeSeconds: 60,
		});
	};

	it("covers every DID with the appview, syncer and notifs fragments", () => {
		expect(serviceAuthAudience([PRIMARY, ALIAS])).toEqual([
			PRIMARY,
			`${PRIMARY}#colibri_appview`,
			`${PRIMARY}#atproto_space_syncer`,
			`${PRIMARY}#colibri_notifs`,
			ALIAS,
			`${ALIAS}#colibri_appview`,
			`${ALIAS}#atproto_space_syncer`,
			`${ALIAS}#colibri_notifs`,
		]);
	});

	it("accepts a token for the alias's appview service when the alias is set", async () => {
		const token = await mint(`${ALIAS}#colibri_appview`);
		const caller = await authFor([PRIMARY, ALIAS]).verify(token, null);

		expect(caller.did).toBe(CALLER);
	});

	it("refuses a token for the alias's appview service when the alias is not set", async () => {
		const token = await mint(`${ALIAS}#colibri_appview`);
		const verifying = authFor([PRIMARY]).verify(token, null);

		await expect(verifying).rejects.toBeInstanceOf(ServiceAuthError);
		await expect(verifying).rejects.toMatchObject({ failure: "wrongAudience" });
	});
});

describe("buildDidDocuments", () => {
	it("gives an alias its own id and endpoints with the same key", () => {
		const documents = buildDidDocuments({ dids: [PRIMARY, ALIAS], publicUrl: PUBLIC_URL }, keypair);
		const alias = didDocumentForHost(documents, "spaces-api.colibri.test");

		expect(documents.primary.id).toBe(PRIMARY);
		expect(alias.id).toBe(ALIAS);
		expect(alias.verificationMethod).toEqual([
			{
				...documents.primary.verificationMethod[0],
				id: `${ALIAS}#atproto`,
				controller: ALIAS,
			},
		]);
		expect(alias.service.map((service) => service.serviceEndpoint)).toEqual([
			"https://spaces-api.colibri.test",
			"https://spaces-api.colibri.test",
			"https://spaces-api.colibri.test",
		]);
	});
});

describe("the did.json route", () => {
	let close: () => Promise<void> = async () => {};

	afterEach(async () => {
		await close();
	});

	const serve = async (didDocuments: DidDocuments) => {
		const ctx = {
			config: { corsOrigins: [], APPVIEW_DID: PRIMARY },
			log: { error: () => {}, warn: () => {}, info: () => {} },
			drain: createDrainState(),
			didDocuments,
		} as unknown as AppContext;
		const server = createAppServer(ctx, { api: false });
		const http = server.router.listen(0);

		await new Promise((resolve) => http.once("listening", resolve));

		close = () => new Promise<void>((resolve) => http.close(() => resolve()));

		const { port } = http.address() as AddressInfo;

		return (headers: Record<string, string>) => {
			return new Promise<{ id: string }>((resolve, reject) => {
				const outgoing = httpRequest(
					{ host: "127.0.0.1", port, path: "/.well-known/did.json", headers },
					(response) => {
						let body = "";

						response.setEncoding("utf8");
						response.on("data", (chunk: string) => {
							body += chunk;
						});
						response.on("end", () => resolve(JSON.parse(body)));
					},
				);

				outgoing.on("error", reject);
				outgoing.end();
			});
		};
	};

	const documents = () => {
		return buildDidDocuments({ dids: [PRIMARY, ALIAS], publicUrl: PUBLIC_URL }, keypair);
	};

	it("answers the primary host with the primary document", async () => {
		const fetchDid = await serve(documents());

		expect((await fetchDid({ host: "api.colibri.test" })).id).toBe(PRIMARY);
	});

	it("answers an alias host with the alias document", async () => {
		const fetchDid = await serve(documents());

		expect((await fetchDid({ host: "spaces-api.colibri.test" })).id).toBe(ALIAS);
		expect((await fetchDid({ host: "Spaces-API.colibri.test" })).id).toBe(ALIAS);
	});

	it("answers an unknown host with the primary document", async () => {
		const fetchDid = await serve(documents());

		expect((await fetchDid({ host: "eu-2.nodes.colibri.test" })).id).toBe(PRIMARY);
	});

	it("ignores X-Forwarded-Host, since the server trusts no proxy", async () => {
		const fetchDid = await serve(documents());
		const forwarded = await fetchDid({
			host: "api.colibri.test",
			"x-forwarded-host": "spaces-api.colibri.test",
		});

		expect(forwarded.id).toBe(PRIMARY);
	});
});
