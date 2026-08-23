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
