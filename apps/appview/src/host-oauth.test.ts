import { JoseKey } from "@atproto/oauth-client-node";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { SecretBox } from "@colibri-social/community";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_OAUTH_PATHS, HostOAuth, hostOAuthScope } from "./host-oauth.js";

const PUBLIC_URL = "https://spaces-api.colibri.test";
const APPVIEW = "did:web:spaces-api.colibri.test";

let database: TestDatabase;

const create = async () => {
	const key = await JoseKey.generate(["ES256"], "host-test");
	return HostOAuth.create({
		database,
		secrets: await SecretBox.fromBase64(SecretBox.generateKeyBase64()),
		publicUrl: PUBLIC_URL,
		appviewDid: APPVIEW,
		privateKey: JSON.stringify(key.privateJwk),
		keyId: "host-test",
		plcUrl: "https://plc.directory",
		handleOf: async (did) => did,
		onLost: () => {},
	});
};

beforeEach(async () => {
	database = await openTestDatabase();
});

afterEach(async () => {
	await database.destroy();
});

describe("host sign-in client", () => {
	it("publishes confidential client metadata under the AppView's own URL", async () => {
		const oauth = await create();

		expect(oauth.clientMetadata).toMatchObject({
			client_id: `${PUBLIC_URL}${HOST_OAUTH_PATHS.metadata}`,
			redirect_uris: [`${PUBLIC_URL}${HOST_OAUTH_PATHS.callback}`],
			jwks_uri: `${PUBLIC_URL}${HOST_OAUTH_PATHS.jwks}`,
			token_endpoint_auth_method: "private_key_jwt",
			dpop_bound_access_tokens: true,
			scope: hostOAuthScope(APPVIEW),
		});
	});

	it("publishes only the public half of its key", async () => {
		const oauth = await create();
		const { keys } = JSON.parse(JSON.stringify(oauth.jwks)) as {
			keys: Array<Record<string, unknown>>;
		};

		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ kid: "host-test", kty: "EC" });
		expect(keys[0]).not.toHaveProperty("d");
	});
});
