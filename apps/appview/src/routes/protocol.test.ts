import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createXrpcServer } from "@atproto/xrpc-server";
import { communitySpaces } from "@colibri-social/lexicons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authVerifiers } from "../auth.js";
import type { AppContext } from "../context.js";
import { registerProtocolRoutes } from "./protocol.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxx";
const STRANGER = "did:plc:strangerxxxxxxxxxxxxxxxxxxxx";
const MEMBERS_SPACE = communitySpaces(COMMUNITY).members;
const TOKEN = "issued-token";
const REV = "3mwcj3b6uak22";
const NEXT_REV = "3mwcj3b6uak23";

type Calls = {
	writes: unknown[][];
	removals: unknown[][];
	deleteChecks: string[];
	renewals: unknown[][];
	lxms: Array<string | null>;
};

let http: HttpServer;
let base: string;
let calls: Calls;

const contextFor = (): AppContext => {
	return {
		log: { debug: () => undefined, warn: () => undefined },
		serviceAuth: {
			verify: async (token: string, lxm: string | null) => {
				calls.lxms.push(lxm);

				return { did: token, lxm };
			},
		},
		notifyTokens: {
			matches: async (space: string, token: string) => space === MEMBERS_SPACE && token === TOKEN,
		},
		loader: {
			community: async (did: string) => (did === COMMUNITY ? { did } : null),
			authz: async (community: string, actor: string) => ({
				actor,
				community,
				isOwner: false,
				isBanned: false,
				member: actor === MEMBER ? {} : null,
				roles: [],
			}),
			spaceStates: async () => ({ channel: null, thread: null }),
		},
		sync: {
			notifyWrite: (...args: unknown[]) => void calls.writes.push(args),
			notifyRepoRemoved: (...args: unknown[]) => void calls.removals.push(args),
			confirmSpaceDeleted: async (space: string) => void calls.deleteChecks.push(space),
			renewLapsedRegistration: async (...args: unknown[]) => void calls.renewals.push(args),
		},
	} as unknown as AppContext;
};

const post = (nsid: string, body: unknown): Promise<Response> => {
	return fetch(`${base}/xrpc/${nsid}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
};

const checkAccess = (caller: string, params: Record<string, string>): Promise<Response> => {
	const query = new URLSearchParams({ space: MEMBERS_SPACE, ...params });

	return fetch(`${base}/xrpc/com.atproto.managedspace.checkAccess?${query}`, {
		headers: { authorization: `Bearer ${caller}` },
	});
};

const notify = (update: unknown, token = TOKEN): Promise<Response> => {
	return post("com.atproto.space.notifySpaceUpdate", { space: MEMBERS_SPACE, token, update });
};

beforeEach(async () => {
	calls = { writes: [], removals: [], deleteChecks: [], renewals: [], lxms: [] };

	const ctx = contextFor();
	const server = createXrpcServer(undefined, {
		payload: { jsonLimit: 100_000, blobLimit: 100_000 },
		catchall: undefined,
	});

	registerProtocolRoutes({ server, ctx, auth: authVerifiers(ctx) });

	http = createHttpServer(server.router);
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise((resolve) => http.close(resolve));
});

describe("confirmRegistration", () => {
	it("echoes the challenge for a token issued for the space", async () => {
		const response = await post("com.atproto.space.confirmRegistration", {
			space: MEMBERS_SPACE,
			token: TOKEN,
			challenge: "prove-it",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: "prove-it" });
	});

	it("refuses a token it did not issue for the space", async () => {
		const response = await post("com.atproto.space.confirmRegistration", {
			space: MEMBERS_SPACE,
			token: "guessed",
			challenge: "prove-it",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "InvalidRequest" });
	});
});

describe("notifySpaceUpdate", () => {
	it("syncs a repo on a write notice", async () => {
		const response = await notify({
			$type: "com.atproto.space.defs#repoWrite",
			repo: MEMBER,
			repoRev: REV,
			data: { $bytes: Buffer.alloc(32, 1).toString("base64") },
			spaceRev: NEXT_REV,
			prevSpaceRev: REV,
		});

		expect(response.status).toBe(200);
		expect(calls.writes).toEqual([
			[
				MEMBERS_SPACE,
				MEMBER,
				expect.objectContaining({
					rev: REV,
					spaceRev: NEXT_REV,
					prevSpaceRev: REV,
					setHashBase64: Buffer.alloc(32, 1).toString("base64"),
					trigger: "notify",
				}),
			],
		]);
	});

	it("drops a repo on a removal notice", async () => {
		const response = await notify({
			$type: "com.atproto.space.defs#repoRemoved",
			repo: MEMBER,
			spaceRev: NEXT_REV,
		});

		expect(response.status).toBe(200);
		expect(calls.removals).toEqual([
			[MEMBERS_SPACE, MEMBER, { spaceRev: NEXT_REV, prevSpaceRev: undefined }],
		]);
	});

	it("checks with the authority before acting on a deletion notice", async () => {
		const response = await notify({ $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" });

		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(calls.deleteChecks).toEqual([MEMBERS_SPACE]));
	});

	it("reauthorizes after a registration lapsed", async () => {
		const response = await notify({
			$type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
			spaceRev: NEXT_REV,
		});

		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(calls.renewals).toEqual([[MEMBERS_SPACE, NEXT_REV]]));
	});

	it("refuses an update carrying a token it did not issue", async () => {
		const response = await notify(
			{ $type: "com.atproto.space.notifySpaceUpdate#registrationExpired", spaceRev: NEXT_REV },
			"guessed",
		);

		expect(response.status).toBe(400);
		expect(calls.renewals).toEqual([]);
	});
});

describe("checkAccess", () => {
	it("answers both read and write for a repo", async () => {
		const response = await checkAccess(COMMUNITY, { repo: MEMBER });

		expect(await response.json()).toEqual({ read: true, write: false });
		expect(calls.lxms).toEqual(["com.atproto.managedspace.checkAccess"]);
	});

	it("refuses a repo outside the community", async () => {
		const response = await checkAccess(COMMUNITY, { repo: STRANGER });

		expect(await response.json()).toEqual({ read: false, write: false });
	});

	it("keeps the space private when no repo is named", async () => {
		const response = await checkAccess(COMMUNITY, {});

		expect(await response.json()).toEqual({ read: false, write: false });
	});

	it("refuses a caller that is not the space authority", async () => {
		const response = await checkAccess(MEMBER, { repo: MEMBER });

		expect(await response.json()).toEqual({ read: false, write: false });
	});
});
