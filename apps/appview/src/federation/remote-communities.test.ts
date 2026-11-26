import { describe, expect, it, vi } from "vitest";
import type { ForwardAnswer, Forwarder, ForwardRequest } from "./forward.js";
import { ForwardUnreachable } from "./forward.js";
import { createRemoteCommunities, REMOTE_COMMUNITY_TIMEOUT_MS } from "./remote-communities.js";
import type { SpaceHost } from "./resolve-host.js";

const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const SPACE = "did:plc:spacexxxxxxxxxxxxxxxxxxxxx";
const THEIRS = "did:web:other.example";
const ROW = { community: SPACE, managingApp: THEIRS };
const REMOTE: SpaceHost = { local: false, managingApp: THEIRS, endpoint: "https://other.example" };

const answer = (status: number, body: unknown): ForwardAnswer => {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: Buffer.from(JSON.stringify(body)),
	};
};

const setup = (options: {
	enabled?: boolean;
	host?: SpaceHost | undefined | Error;
	forward?: Forwarder;
}) => {
	const forget = vi.fn(async () => {});
	const forward = vi.fn(options.forward ?? (async () => answer(200, {})));
	const host = "host" in options ? options.host : REMOTE;
	const remote = createRemoteCommunities({
		enabled: options.enabled ?? true,
		hosts: {
			resolve: async () => {
				if (host instanceof Error) throw host;

				return host;
			},
			forget,
		},
		forward,
	});

	return { remote, forward, forget };
};

describe("createRemoteCommunities", () => {
	it("asks the managing AppView for the community as the user, with a short timeout", async () => {
		const view = { did: SPACE, name: "Elsewhere", managingApp: THEIRS };
		const { remote, forward } = setup({ forward: async () => answer(200, { community: view }) });

		await expect(remote.fetch(USER, [ROW])).resolves.toEqual([{ kind: "view", view }]);

		const request = forward.mock.calls[0]?.[1] as ForwardRequest;

		expect(forward.mock.calls[0]?.[0]).toBe(REMOTE);
		expect(request).toMatchObject({
			method: "GET",
			nsid: "social.colibri.beta.community.getCommunity",
			actingFor: USER,
			timeoutMs: REMOTE_COMMUNITY_TIMEOUT_MS,
		});
		expect(request.path).toBe(
			`/xrpc/social.colibri.beta.community.getCommunity?community=${encodeURIComponent(SPACE)}`,
		);
	});

	it("marks the community unavailable when its AppView doesn't answer", async () => {
		const { remote } = setup({
			forward: async () => {
				throw new ForwardUnreachable(THEIRS);
			},
		});

		await expect(remote.fetch(USER, [ROW])).resolves.toEqual([
			{ kind: "unavailable", did: SPACE, managingApp: THEIRS },
		]);
	});

	it("marks the community unavailable on an error answer, and drops it when it no longer exists", async () => {
		const failing = setup({ forward: async () => answer(502, { error: "UpstreamFailure" }) });
		const missing = setup({ forward: async () => answer(400, { error: "CommunityNotFound" }) });

		await expect(failing.remote.fetch(USER, [ROW])).resolves.toEqual([
			{ kind: "unavailable", did: SPACE, managingApp: THEIRS },
		]);
		await expect(missing.remote.fetch(USER, [ROW])).resolves.toEqual([{ kind: "gone" }]);
	});

	it("forgets the cached host when the AppView says it no longer manages the community", async () => {
		const { remote, forget } = setup({
			forward: async () =>
				answer(400, { error: "NotManagingApp", managingApp: "did:web:new.example" }),
		});

		await remote.fetch(USER, [ROW]);
		expect(forget).toHaveBeenCalledWith(SPACE);
	});

	it("uses the record's AppView when the host lookup fails or finds nothing", async () => {
		const failed = setup({ host: new Error("network down") });
		const unknown = setup({ host: undefined });
		const expected = [{ kind: "unavailable", did: SPACE, managingApp: THEIRS }];

		await expect(failed.remote.fetch(USER, [ROW])).resolves.toEqual(expected);
		await expect(unknown.remote.fetch(USER, [ROW])).resolves.toEqual(expected);
	});

	it("drops a community this AppView manages now, since the members table lists it", async () => {
		const { remote, forward } = setup({
			host: { local: true, managingApp: "did:web:appview.test" },
		});

		await expect(remote.fetch(USER, [ROW])).resolves.toEqual([{ kind: "gone" }]);
		expect(forward).not.toHaveBeenCalled();
	});

	it("reaches no other AppView when federation is off", async () => {
		const { remote, forward } = setup({ enabled: false });

		await expect(remote.fetch(USER, [ROW])).resolves.toEqual([
			{ kind: "unavailable", did: SPACE, managingApp: THEIRS },
		]);
		expect(forward).not.toHaveBeenCalled();
	});
});
