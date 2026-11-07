import { describe, expect, it, vi } from "vitest";
import type { EventMessage, MessageView } from "./announce.js";
import type { BusDelivery } from "./bus.js";
import type { AppContext } from "./context.js";
import { eventDelivery } from "./event-delivery.js";
import type { ChannelFrame, EventServer, ServerFrame } from "./ws/events.js";

const SPACE = "ats://did:plc:community/social.colibri.beta.channel.text/3lkchannel0000";
const COMMUNITY = "did:plc:community";
const VIEWER = "did:plc:viewer";

const harness = (waitForReplay = vi.fn(async () => true)) => {
	const sent: { space: string; frame: ServerFrame }[] = [];
	const events = {
		publishToChannel: (space: string, frame: ChannelFrame) => {
			sent.push({ space, frame: typeof frame === "function" ? frame(VIEWER) : frame });
		},
		publishToCommunityPermission: vi.fn(async () => {}),
		publishToCommunityViewers: vi.fn(async () => {}),
		publishToBridges: vi.fn(async () => {}),
	} as unknown as EventServer;
	const ctx = {
		config: { PUBLIC_URL: "https://appview.test", SIGNING_KEY: "a".repeat(64) },
		database: { waitForReplay },
		loader: { threadRow: vi.fn(async () => null) },
		log: { warn: vi.fn(), debug: vi.fn() },
	} as unknown as AppContext;
	const authz = vi.fn();
	const deliver = eventDelivery({ ctx, events, authz });

	return { deliver, sent, events, ctx, authz, waitForReplay };
};

const remote = (
	message: EventMessage,
	lsn: string | null = "0/16B3748",
): BusDelivery<EventMessage> => {
	return { message, origin: "node-main", lsn, local: false };
};

const message = {
	uri: `${SPACE}/message`,
	rkey: "3lkmessage0000",
	text: "hi",
	author: { did: "did:plc:author", handle: "author.test" },
	attachments: [],
} as unknown as MessageView;

describe("eventDelivery", () => {
	it("renders a message recipe into a messageEvent for each viewer", async () => {
		const { deliver, sent } = harness();

		await deliver(remote({ t: "message", space: SPACE, event: "create", message, imported: true }));

		expect(sent).toEqual([
			{
				space: SPACE,
				frame: expect.objectContaining({
					$type: "social.colibri.beta.sync.defs#messageEvent",
					event: "create",
					channel: SPACE,
					imported: true,
					message: expect.objectContaining({ rkey: "3lkmessage0000" }),
				}),
			},
		]);
	});

	it("does not wait for the replica on frames that need no database", async () => {
		const { deliver, waitForReplay } = harness();

		await deliver(remote({ t: "message", space: SPACE, event: "create", message }));

		expect(waitForReplay).not.toHaveBeenCalled();
	});

	it("waits for the replica before rendering a thread recipe from another node", async () => {
		const { deliver, waitForReplay } = harness();

		await deliver(
			remote({
				t: "thread",
				recipe: {
					community: COMMUNITY,
					space: SPACE,
					event: "update",
					whenHidden: "skip",
					bridges: true,
				},
			}),
		);

		expect(waitForReplay).toHaveBeenCalledWith("0/16B3748", expect.any(Number));
	});

	it("still delivers when the replica stays behind", async () => {
		const { deliver, events, ctx } = harness(vi.fn(async () => false));
		const frame = { $type: "social.colibri.beta.sync.defs#moderationEvent" };

		await deliver(
			remote({
				t: "communityPermission",
				community: COMMUNITY,
				permission: "moderation.viewLog",
				frame,
			}),
		);

		expect(ctx.log.warn).toHaveBeenCalled();
		expect(events.publishToCommunityPermission).toHaveBeenCalledWith(
			COMMUNITY,
			"moderation.viewLog",
			frame,
		);
	});

	it("skips the wait for its own messages", async () => {
		const { deliver, waitForReplay } = harness();

		await deliver({
			message: {
				t: "thread",
				recipe: {
					community: COMMUNITY,
					space: SPACE,
					event: "update",
					whenHidden: "skip",
					bridges: false,
				},
			},
			origin: "node-main",
			lsn: null,
			local: true,
		});

		expect(waitForReplay).not.toHaveBeenCalled();
	});

	it("hands authorization changes to the local listeners", async () => {
		const { deliver, authz } = harness();
		const change = { community: COMMUNITY, collection: "social.colibri.beta.member" };

		await deliver(remote({ t: "authz", change }));

		expect(authz).toHaveBeenCalledWith(change);
	});
});
