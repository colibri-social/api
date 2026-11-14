import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Fetch,
	SUPPORTED_TTL_MS,
	spacesSupport,
	spacesSupportProbe,
	UNSUPPORTED_TTL_MS,
} from "./detect.js";

const PDS = "https://pds.test";

const reply = (status: number, body: unknown) => {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
};

const fetchFor = (answers: Record<string, () => Response>): Fetch => {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		const method = Object.keys(answers).find((name) => url.includes(`/xrpc/${name}`));
		if (!method) return reply(404, { error: "MethodNotImplemented" });

		return answers[method]?.() ?? reply(404, {});
	}) as Fetch;
};

describe("spacesSupportProbe", () => {
	it("trusts the service descriptor when there is one", async () => {
		const probe = spacesSupportProbe(
			fetchFor({
				"community.lexicon.service.describe": () => {
					return reply(200, { methods: [{ value: "com.atproto.space.getDelegationToken" }] });
				},
			}),
		);

		expect(await probe(PDS)).toBe(true);
	});

	it("reads a stock server's identical answers as no support", async () => {
		expect(await spacesSupportProbe(fetchFor({}))(PDS)).toBe(false);
	});

	it("reads a parameter error from the real method as support", async () => {
		const probe = spacesSupportProbe(
			fetchFor({
				"com.atproto.space.getDelegationToken": () => {
					return reply(400, { error: "InvalidSpaceRef", message: "bad space" });
				},
			}),
		);

		expect(await probe(PDS)).toBe(true);
	});

	it("gives no answer while the server errors", async () => {
		const probe = spacesSupportProbe(
			fetchFor({ "com.atproto.space.getDelegationToken": () => reply(502, {}) }),
		);

		expect(await probe(PDS)).toBeUndefined();
	});
});

describe("spacesSupport", () => {
	let database: TestDatabase;
	let now: Date;
	let probes: number;
	let answer: boolean;

	const support = () => {
		return spacesSupport({
			database,
			now: () => now,
			probe: async () => {
				probes += 1;

				return answer;
			},
		});
	};

	beforeEach(async () => {
		database = await openTestDatabase();
		now = new Date("2026-11-14T00:00:00.000Z");
		probes = 0;
		answer = false;
	});

	afterEach(async () => {
		await database.destroy();
	});

	it("keeps a negative answer for an hour", async () => {
		await support().check(PDS);
		now = new Date(now.getTime() + UNSUPPORTED_TTL_MS - 1);
		await support().check(PDS);

		expect(probes).toBe(1);

		now = new Date(now.getTime() + 2);
		await support().check(PDS);

		expect(probes).toBe(2);
	});

	it("keeps a positive answer for a day", async () => {
		answer = true;

		await support().check(PDS);
		now = new Date(now.getTime() + SUPPORTED_TTL_MS - 1);

		expect(await support().check(PDS)).toBe(true);
		expect(probes).toBe(1);
	});

	it("asks again when a fresh answer is wanted", async () => {
		await support().check(PDS);
		await support().check(PDS, { fresh: true });

		expect(probes).toBe(2);
	});
});
