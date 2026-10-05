import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const REQUIRED = {
	PUBLIC_URL: "https://appview.example.com",
	SIGNING_KEY: "a".repeat(64),
	CREDENTIAL_ENCRYPTION_KEY: "not-checked-here",
	PDS_URL: "https://pds.example.com",
	COMMUNITY_HANDLE_DOMAIN: "communities.example.com",
};

const load = (appviewDid: string) => loadConfig({ ...REQUIRED, APPVIEW_DID: appviewDid });

describe("APPVIEW_DID", () => {
	it("accepts a hostname, with or without a port", () => {
		expect(load("did:web:appview.example.com").APPVIEW_DID).toBe("did:web:appview.example.com");
		expect(load("did:web:localhost%3A8000").APPVIEW_DID).toBe("did:web:localhost%3A8000");
	});

	it("refuses a bare IP, which a PDS will not accept as a service-auth audience", () => {
		expect(() => load("did:web:127.0.0.1%3A8000")).toThrow(ConfigError);
		expect(() => load("did:web:127.0.0.1")).toThrow(ConfigError);
		expect(() => load("did:web:10.0.0.7%3A3000")).toThrow(ConfigError);
	});

	it("names the working alternative in the error, so the fix does not need a search", () => {
		expect(() => load("did:web:127.0.0.1%3A8000")).toThrow(/did:web:spaces-api\.colibri\.social/);
	});

	it("still refuses a DID that is not a did:web at all", () => {
		expect(() => load("did:plc:mprdjqjluoswa7awzggaggj3")).toThrow(ConfigError);
	});
});

describe("DEFAULT_COMMUNITY_DID", () => {
	const withDefault = (value: string | undefined) =>
		loadConfig({
			...REQUIRED,
			APPVIEW_DID: "did:web:appview.example.com",
			DEFAULT_COMMUNITY_DID: value,
		});

	it("is off when unset or empty", () => {
		expect(withDefault(undefined).DEFAULT_COMMUNITY_DID).toBeUndefined();
		expect(withDefault("").DEFAULT_COMMUNITY_DID).toBeUndefined();
	});

	it("accepts a DID", () => {
		expect(withDefault("did:plc:mprdjqjluoswa7awzggaggj3").DEFAULT_COMMUNITY_DID).toBe(
			"did:plc:mprdjqjluoswa7awzggaggj3",
		);
	});

	it("refuses a value that is not a DID", () => {
		expect(() => withDefault("colibri.social")).toThrow(ConfigError);
	});
});

describe("APNs", () => {
	const withApns = (env: Record<string, string>) =>
		loadConfig({ ...REQUIRED, APPVIEW_DID: "did:web:appview.example.com", ...env });

	it("enables apns when key, key ID and team ID are all set", () => {
		const config = withApns({
			APNS_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
			APNS_KEY_ID: "KEY1234567",
			APNS_TEAM_ID: "TEAM123456",
		});
		expect(config.pushProviders).toContain("apns");
		expect(config.notifications.apns).toEqual({
			key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
			keyId: "KEY1234567",
			teamId: "TEAM123456",
			topic: "social.colibri.app",
		});
	});

	it("accepts a base64-encoded key", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
		const config = withApns({
			APNS_KEY: Buffer.from(pem).toString("base64"),
			APNS_KEY_ID: "KEY1234567",
			APNS_TEAM_ID: "TEAM123456",
		});
		expect(config.notifications.apns?.key).toBe(pem);
	});

	it("stays off while any part of the key is missing", () => {
		const config = withApns({ APNS_KEY: "key", APNS_KEY_ID: "KEY1234567" });
		expect(config.pushProviders).not.toContain("apns");
		expect(config.notifications.apns).toBeUndefined();
	});
});
