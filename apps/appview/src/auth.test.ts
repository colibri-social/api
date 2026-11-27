import { describe, expect, it } from "vitest";
import { authVerifiers, mayActFor } from "./auth.js";
import type { AppContext } from "./context.js";

const NS = "social.colibri.beta";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";

describe("mayActFor", () => {
	it("accepts forwarded methods and the migration start", () => {
		expect(mayActFor(`${NS}.community.join`)).toBe(true);
		expect(mayActFor(`${NS}.channel.listMessages`)).toBe(true);
		expect(mayActFor(`${NS}.polyfill.beginMigration`)).toBe(true);
	});

	it("refuses local and unknown methods", () => {
		expect(mayActFor(`${NS}.actor.getPreferences`)).toBe(false);
		expect(mayActFor(`${NS}.notification.listNotifications`)).toBe(false);
		expect(mayActFor(`${NS}.bridge.register`)).toBe(false);
		expect(mayActFor("com.example.unknown")).toBe(false);
		expect(mayActFor(null)).toBe(false);
	});
});

describe("authVerifiers", () => {
	it("refuses an acting-for request on a method that's never forwarded", async () => {
		const verifiers = authVerifiers({} as AppContext);

		const request = {
			req: {
				url: `/xrpc/${NS}.actor.getPreferences`,
				headers: {
					authorization: "Bearer peer-token",
					"colibri-acting-for": USER,
				},
			},
		};

		await expect(verifiers.required(request as never)).rejects.toMatchObject({
			customErrorName: "ActingForNotAllowed",
		});
	});
});
