import type { PdsClient } from "@colibri-social/space";
import { XrpcError } from "@colibri-social/space";
import { describe, expect, it, vi } from "vitest";
import type { CommunityHost } from "./credentials.js";
import { ensureHostRecord } from "./host-record.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxx";
const OURS = "did:web:appview.example";
const NOW = new Date("2026-11-26T12:00:00.000Z");

const hostWith = (read: () => Promise<unknown>) => {
	const putRepoRecord = vi.fn(async () => ({ uri: "at://x", cid: "bafycid" }));
	const host = {
		pds: { getPublicRecord: vi.fn(read), putRepoRecord } as unknown as PdsClient,
		session: { did: COMMUNITY, handle: "space.example", run: vi.fn() },
	} as CommunityHost;

	return { host, putRepoRecord };
};

const notFound = () =>
	Promise.reject(
		new XrpcError(400, "RecordNotFound", "Could not locate record", "com.atproto.repo.getRecord"),
	);

describe("ensureHostRecord", () => {
	it("writes the record when the repo has none", async () => {
		const { host, putRepoRecord } = hostWith(notFound);

		await expect(ensureHostRecord(host, OURS, NOW)).resolves.toBe(true);
		expect(putRepoRecord).toHaveBeenCalledWith(host.session, {
			collection: "social.colibri.beta.community.host",
			rkey: "self",
			record: {
				$type: "social.colibri.beta.community.host",
				managingApp: OURS,
				updatedAt: NOW.toISOString(),
			},
		});
	});

	it("leaves a record that already names this AppView alone", async () => {
		const { host, putRepoRecord } = hostWith(async () => ({ value: { managingApp: OURS } }));

		await expect(ensureHostRecord(host, OURS, NOW)).resolves.toBe(false);
		expect(putRepoRecord).not.toHaveBeenCalled();
	});

	it("replaces a record that names another AppView", async () => {
		const { host, putRepoRecord } = hostWith(async () => ({
			value: { managingApp: "did:web:old.example" },
		}));

		await expect(ensureHostRecord(host, OURS, NOW)).resolves.toBe(true);
		expect(putRepoRecord).toHaveBeenCalledOnce();
	});

	it("passes on a failure other than a missing record", async () => {
		const { host, putRepoRecord } = hostWith(() =>
			Promise.reject(
				new XrpcError(502, "UpstreamFailure", "bad gateway", "com.atproto.repo.getRecord"),
			),
		);

		await expect(ensureHostRecord(host, OURS, NOW)).rejects.toMatchObject({
			code: "UpstreamFailure",
		});
		expect(putRepoRecord).not.toHaveBeenCalled();
	});
});
