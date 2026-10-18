import { Writable } from "node:stream";
import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { BlobNotFoundError, BlobRejectedError, type BlobResult } from "@colibri-social/blobs";
import { CommunityLoader } from "@colibri-social/community";
import {
	COLLECTIONS,
	channelSpace,
	communitySpaces,
	LABEL_VALUES,
	SPACE_TYPES,
	threadSpace,
} from "@colibri-social/lexicons";
import { nextTid } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { signMediaGrant } from "../media-token.js";
import { mountBlobRoutes } from "./blob.js";

const NOW = "2026-08-23T00:00:00.000Z";
const SIGNING_KEY = "c".repeat(64);
const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxxxx";
const OUTSIDER = "did:plc:outsiderxxxxxxxxxxxxxxxxxxxxx";
const CID = "bafkreiblobxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SKEY = "3lkchannelblob1";
const SPACE = channelSpace(COMMUNITY, SPACE_TYPES.channelText, SKEY);
const THREAD_SKEY = "3lkthreadblob01";
const THREAD = threadSpace(COMMUNITY, THREAD_SKEY);

type Handler = (req: unknown, res: unknown) => Promise<void>;

type Captured = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
};

let database: TestDatabase;
let handler: Handler;
let served: number;
let fetchedFrom: Array<string | undefined>;
let missingIn: Set<string>;
let nextResult: (() => BlobResult) | null;
let logged: { level: string; detail: Record<string, unknown>; event: string }[];

const fakeResponse = () => {
	const captured: Captured = { status: 200, headers: {}, body: undefined };
	const res = {
		setHeader: (name: string, value: string) => {
			captured.headers[name.toLowerCase()] = String(value);
		},
		status: (code: number) => {
			captured.status = code;
			return res;
		},
		json: (value: unknown) => {
			captured.body = value;
			return res;
		},
		end: (value?: unknown) => {
			captured.body = value ?? captured.body;
			return res;
		},
	};
	return { res, captured };
};

const streamingResponse = () => {
	const captured: Captured & { chunks: Buffer[]; destroyed: boolean } = {
		status: 200,
		headers: {},
		body: undefined,
		chunks: [],
		destroyed: false,
	};
	const res = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			captured.chunks.push(chunk);
			callback();
		},
		destroy(error, callback) {
			captured.destroyed = true;
			callback(error);
		},
	}) as Writable & Record<string, unknown>;
	res.setHeader = (name: string, value: string) => {
		captured.headers[name.toLowerCase()] = String(value);
	};
	res.status = (code: number) => {
		captured.status = code;
		return res;
	};
	res.json = (value: unknown) => {
		captured.body = value;
		return res;
	};
	return { res, captured };
};

const signedFor = (viewer: string, space: string = SPACE) => {
	const { expiresAt, signature } = signMediaGrant(
		SIGNING_KEY,
		{ did: AUTHOR, cid: CID, space, viewer },
		Math.floor(Date.now() / 1000),
	);
	return { viewer, exp: String(expiresAt), sig: signature };
};

const putMovedMessage = async (destination: string, cid: string) => {
	const rkey = nextTid();
	await database.db.insert(database.tables.threads).values({
		space: THREAD,
		community: COMMUNITY,
		channel: SPACE,
		skey: THREAD_SKEY,
		name: "side conversation",
		createdBy: AUTHOR,
		createdAt: NOW,
		visibleToRoles: [],
		visibleToMembers: [],
		lastActivityAt: NOW,
		indexedAt: NOW,
	});
	await database.db.insert(database.tables.messages).values({
		space: SPACE,
		author: AUTHOR,
		rkey,
		community: COMMUNITY,
		text: "with a picture",
		createdAt: NOW,
		fromLegacyRepo: false,
		indexedAt: NOW,
		attachments: [{ name: "shot.png", blob: { $type: "blob", ref: { $link: cid } } }],
	});
	await database.db.insert(database.tables.labels).values({
		space: SPACE,
		src: COMMUNITY,
		rkey: nextTid(),
		subjectDid: AUTHOR,
		subjectCollection: COLLECTIONS.message,
		subjectRkey: rkey,
		val: LABEL_VALUES.moved,
		negated: false,
		destination,
		batch: nextTid(),
		createdAt: NOW,
	});
};

const get = async (
	query: Record<string, string>,
	headers: Record<string, string> = {},
): Promise<Captured> => {
	const { res, captured } = fakeResponse();
	await handler({ query, headers, url: "/xrpc/social.colibri.beta.blob.get" }, res);
	return captured;
};

beforeEach(async () => {
	database = await openTestDatabase();
	served = 0;
	fetchedFrom = [];
	missingIn = new Set();
	nextResult = null;
	logged = [];
	const spaces = communitySpaces(COMMUNITY);

	await database.db.insert(database.tables.communities).values({
		did: COMMUNITY,
		handle: null,
		name: "Test Community",
		description: null,
		pictureCid: null,
		bannerCid: null,
		requiresApproval: false,
		linkEmbeds: true,
		labelers: [],
		migratedFrom: null,
		profileSpace: spaces.profile,
		configSpace: spaces.configuration,
		membersSpace: spaces.members,
		moderationSpace: spaces.moderation,
		indexedAt: NOW,
	});
	await database.db.insert(database.tables.channels).values({
		space: SPACE,
		community: COMMUNITY,
		spaceType: SPACE_TYPES.channelText,
		skey: SKEY,
		name: "general",
	});
	await database.db.insert(database.tables.members).values({
		community: COMMUNITY,
		did: MEMBER,
		roles: [],
		joinedAt: NOW,
	});

	const ctx = {
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY },
		database,
		loader: new CommunityLoader({ db: database.db, tables: database.tables }),
		log: {
			warn: (detail: Record<string, unknown>, event: string) =>
				logged.push({ level: "warn", detail, event }),
			info: (detail: Record<string, unknown>, event: string) =>
				logged.push({ level: "info", detail, event }),
			debug: () => {},
		},
		bridges: { mayRead: async () => false },
		serviceAuth: {
			verify: async (token: string) => {
				if (token === "member-token") return { did: MEMBER, lxm: null };
				if (token === "outsider-token") return { did: OUTSIDER, lxm: null };
				throw new Error("bad token");
			},
		},
		blobs: {
			fetch: async ({ space }: { space?: string }) => {
				fetchedFrom.push(space);
				if (space && missingIn.has(space)) throw new BlobNotFoundError();
				served += 1;
				if (nextResult) return nextResult();
				return {
					status: "ok" as const,
					bytes: new Uint8Array([1, 2, 3]),
					mimeType: "image/png",
					totalSize: 3,
				};
			},
		},
	} as unknown as AppContext;

	const app = {
		get: (_path: string, registered: Handler) => {
			handler = registered;
		},
	};
	mountBlobRoutes(ctx, app as never);
});

afterEach(async () => {
	await database.destroy();
});

describe("blob.get authorization", () => {
	it("serves a public blob with no space and no credentials", async () => {
		const result = await get({ did: AUTHOR, cid: CID });
		expect(result.status).toBe(200);
		expect(served).toBe(1);
		expect(result.headers["cache-control"]).toContain("public");
	});

	it("refuses a permissioned blob with no credentials at all", async () => {
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE });
		expect(result.status).toBe(401);
		expect(served).toBe(0);
	});

	it("serves a permissioned blob to a member via a signed link", async () => {
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER) });
		expect(result.status).toBe(200);
		expect(served).toBe(1);
		expect(result.headers["cache-control"]).toContain("private");
		expect(result.headers.etag).toBe(`"${CID}"`);
	});

	it("lets any web origin read a signed link", async () => {
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER) });
		expect(result.headers["access-control-allow-origin"]).toBe("*");
		expect(result.headers["access-control-expose-headers"]).toContain("content-range");
	});

	it("refuses a signed link whose viewer is not a member", async () => {
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(OUTSIDER) });
		expect(result.status).toBe(403);
		expect(served).toBe(0);
	});

	it("refuses a link whose viewer was swapped after signing", async () => {
		const signed = signedFor(OUTSIDER);
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signed, viewer: MEMBER });
		expect(result.status).toBe(401);
		expect(served).toBe(0);
	});

	it("refuses a link whose cid was swapped after signing", async () => {
		const signed = signedFor(MEMBER);
		const result = await get({
			did: AUTHOR,
			cid: "bafkreiotherxxxxxxxxxxxxxxxxxxxxxxxxx",
			space: SPACE,
			...signed,
		});
		expect(result.status).toBe(401);
		expect(served).toBe(0);
	});

	it("accepts service auth as an alternative to a signed link", async () => {
		const result = await get(
			{ did: AUTHOR, cid: CID, space: SPACE },
			{ authorization: "Bearer member-token" },
		);
		expect(result.status).toBe(200);
		expect(served).toBe(1);
	});

	it("still applies membership when service auth is used", async () => {
		const result = await get(
			{ did: AUTHOR, cid: CID, space: SPACE },
			{ authorization: "Bearer outsider-token" },
		);
		expect(result.status).toBe(403);
		expect(served).toBe(0);
	});

	it("serves a moved message's attachment from the space it came from", async () => {
		await putMovedMessage(THREAD, CID);
		missingIn.add(THREAD);

		const captured = await get({
			did: AUTHOR,
			cid: CID,
			space: THREAD,
			...signedFor(MEMBER, THREAD),
		});

		expect(captured.status).toBe(200);
		expect(fetchedFrom).toEqual([THREAD, SPACE]);
	});

	it("still reports a missing blob when nothing was moved into the space", async () => {
		missingIn.add(SPACE);

		const captured = await get({
			did: AUTHOR,
			cid: CID,
			space: SPACE,
			...signedFor(MEMBER),
		});

		expect(captured.status).toBe(404);
		expect(fetchedFrom).toEqual([SPACE]);
	});

	it("refuses an unverifiable bearer token", async () => {
		const result = await get(
			{ did: AUTHOR, cid: CID, space: SPACE },
			{ authorization: "Bearer nonsense" },
		);
		expect(result.status).toBe(401);
		expect(served).toBe(0);
	});

	it("logs a missing blob with its code", async () => {
		missingIn.add(SPACE);
		await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER) });
		expect(logged).toContainEqual(
			expect.objectContaining({
				level: "info",
				detail: expect.objectContaining({ code: "BlobNotFound" }),
			}),
		);
	});
});

describe("blob.get streaming", () => {
	const streamed = async (
		chunks: Uint8Array[],
		failure?: Error,
		mimeType = "video/mp4",
		query: Record<string, string> = {},
	) => {
		nextResult = () => ({
			status: "stream",
			stream: (async function* () {
				for (const chunk of chunks) yield chunk;
				if (failure) throw failure;
			})(),
			mimeType,
			totalSize: 6,
			length: 6,
		});
		const { res, captured } = streamingResponse();
		await handler(
			{
				query: { did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER), ...query },
				headers: {},
				url: "/xrpc/social.colibri.beta.blob.get",
			},
			res,
		);
		return captured;
	};

	it("streams a full blob with its declared length", async () => {
		const captured = await streamed([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
		expect(captured.status).toBe(200);
		expect(captured.headers["content-length"]).toBe("6");
		expect(Buffer.concat(captured.chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
		expect(logged.map((entry) => entry.event)).not.toContain("blob.streamAborted");
	});

	it("destroys the response and logs when the CID check fails at the end", async () => {
		const captured = await streamed(
			[new Uint8Array([1, 2, 3])],
			new BlobRejectedError("cidMismatch"),
		);
		expect(captured.destroyed).toBe(true);
		expect(Buffer.concat(captured.chunks).byteLength).toBeLessThan(6);
		expect(logged).toContainEqual(
			expect.objectContaining({
				level: "warn",
				event: "blob.streamAborted",
				detail: expect.objectContaining({ code: "BlobCidMismatch" }),
			}),
		);
	});

	it("streams a non-media blob as a sandboxed download", async () => {
		const captured = await streamed(
			[new Uint8Array([1, 2, 3, 4, 5, 6])],
			undefined,
			"application/octet-stream",
			{ filename: "notes.zip" },
		);
		expect(captured.headers).toMatchObject({
			"content-type": "application/octet-stream",
			"content-disposition": 'attachment; filename="notes.zip"',
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox; default-src 'none'",
		});
	});
});

describe("blob.get downloads", () => {
	const buffered = (mimeType: string) => () => ({
		status: "ok" as const,
		bytes: new Uint8Array([1, 2, 3]),
		mimeType,
		totalSize: 3,
	});

	it("serves a non-media blob as a sandboxed download", async () => {
		nextResult = buffered("application/octet-stream");
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER) });
		expect(result.status).toBe(200);
		expect(result.headers).toMatchObject({
			"content-type": "application/octet-stream",
			"content-disposition": "attachment",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox; default-src 'none'",
		});
	});

	it("keeps the filename on a download", async () => {
		nextResult = buffered("application/octet-stream");
		const result = await get({
			did: AUTHOR,
			cid: CID,
			space: SPACE,
			...signedFor(MEMBER),
			filename: "photo.heic",
		});
		expect(result.headers["content-disposition"]).toBe('attachment; filename="photo.heic"');
	});

	it("keeps the sniffed type of a media blob", async () => {
		nextResult = buffered("image/png");
		const result = await get({ did: AUTHOR, cid: CID, space: SPACE, ...signedFor(MEMBER) });
		expect(result.headers["content-type"]).toBe("image/png");
		expect(result.headers["content-disposition"]).toBeUndefined();
		expect(result.headers["content-security-policy"]).toBeUndefined();
	});
});
