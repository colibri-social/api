import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "./bridge.js";
import {
	type ColibriClient,
	ColibriRequestError,
	type MessageView,
	type PostMessageInput,
	type RegistrationView,
} from "./client.js";
import type {
	BridgeContext,
	HistoryConnector,
	HistoryMessage,
	HistoryRequest,
	HistoryThread,
	ModeratingConnector,
	OutboundDelete,
	OutboundMessage,
	OutboundReaction,
	OutboundThread,
	OutboundThreadChange,
	OutboundThreadRef,
	ReactingConnector,
	ThreadingConnector,
} from "./connector.js";
import type { EventStreamOptions, ServerFrame } from "./events.js";
import { type BridgeStore, MemoryBridgeStore } from "./store.js";

const COMMUNITY = "did:plc:communityxxxxxxxxxxxxxxxxxxx";
const BRIDGE_DID = "did:plc:bridgexxxxxxxxxxxxxxxxxxxxxx";
const MEMBER = "did:plc:memberxxxxxxxxxxxxxxxxxxxxx";
const CHANNEL = `at://${COMMUNITY}/space/social.colibri.beta.channel.text/3lkchannel001`;
const THREAD = `at://${COMMUNITY}/space/social.colibri.beta.channel.thread/3lkthread0001`;
const REGISTRATION = "3lkbridgeaaaa";
const GUILD = "guild-1";
const ROOM = "room-1";

const registration = (overrides: Partial<RegistrationView> = {}): RegistrationView =>
	({
		id: REGISTRATION,
		community: COMMUNITY,
		bridge: BRIDGE_DID,
		platform: "test",
		remoteSpace: GUILD,
		remoteSpaceName: "Guild",
		links: [{ channel: CHANNEL, remoteRoom: ROOM, remoteName: "general" }],
		enabled: true,
		createdBy: MEMBER,
		createdAt: "2026-09-24T00:00:00.000Z",
		...overrides,
	}) as RegistrationView;

const messageView = (overrides: Record<string, unknown> = {}): MessageView =>
	({
		uri: `at://${MEMBER}/social.colibri.beta.message/3lkmsg0000001`,
		rkey: "3lkmsg0000001",
		channel: CHANNEL,
		author: { did: MEMBER, handle: "member.test", displayName: "Member", isBot: false },
		text: "hello bold",
		facets: [
			{
				index: { byteStart: 6, byteEnd: 10 },
				features: [{ $type: "social.colibri.beta.richtext.facet#bold" }],
			},
		],
		createdAt: "2026-09-24T00:00:00.000Z",
		attachments: [],
		reactions: [],
		labels: [],
		...overrides,
	}) as unknown as MessageView;

class FakeConnector implements ReactingConnector, ThreadingConnector, ModeratingConnector {
	readonly platform = "test";
	context: BridgeContext | null = null;
	sent: OutboundMessage[] = [];
	edits: Array<{ id: string; markdown: string }> = [];
	deletes: string[] = [];
	reactions: Array<{ event: "add" | "remove"; reaction: OutboundReaction }> = [];
	threads: OutboundThread[] = [];
	renames: OutboundThreadChange[] = [];
	archived: OutboundThreadRef[] = [];
	removed: OutboundDelete[] = [];
	nextId = 1;

	async start(context: BridgeContext) {
		this.context = context;
	}
	async stop() {}
	async listRooms() {
		return [{ id: ROOM, name: "general" }];
	}
	async sendMessage(message: OutboundMessage) {
		this.sent.push(message);
		return `remote-${this.nextId++}`;
	}
	async editMessage(edit: { id: string; markdown: string }) {
		this.edits.push({ id: edit.id, markdown: edit.markdown });
	}
	async deleteMessage(target: { id: string }) {
		this.deletes.push(target.id);
	}
	async addReaction(reaction: OutboundReaction) {
		this.reactions.push({ event: "add", reaction });
	}
	async removeReaction(reaction: OutboundReaction) {
		this.reactions.push({ event: "remove", reaction });
	}
	async createThread(thread: OutboundThread) {
		this.threads.push(thread);
		return `remote-thread-${this.threads.length}`;
	}
	async renameThread(thread: OutboundThreadChange) {
		this.renames.push(thread);
	}
	async archiveThread(thread: OutboundThreadRef) {
		this.archived.push(thread);
	}
	async removeMessage(target: OutboundDelete) {
		this.removed.push(target);
	}
}

const fakeClient = (registrations: () => RegistrationView[]) => {
	let rkeys = 0;
	const client = {
		did: BRIDGE_DID,
		appviewUrl: "https://appview.test",
		getConfiguration: vi.fn(async () => registrations()),
		putRemoteRooms: vi.fn(async () => {}),
		createPairing: vi.fn(async () => ({ code: "ABCD2345", expiresAt: "2026-09-24T00:10:00Z" })),
		postMessage: vi.fn(async (_input: PostMessageInput) => ({
			rkey: `3lkposted${String(++rkeys).padStart(4, "a")}`,
		})),
		editMessage: vi.fn(async () => {}),
		deleteMessage: vi.fn(async () => {}),
		addReaction: vi.fn(async () => ({ rkey: `3lkreact${String(++rkeys).padStart(5, "a")}` })),
		removeReaction: vi.fn(async () => {}),
		uploadBlob: vi.fn(async () => ({
			$type: "blob",
			ref: { $link: "bafyavatar" },
			mimeType: "image/png",
			size: 1,
		})),
		fetchBytes: vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" })),
		createThread: vi.fn(async () => ({ thread: THREAD })),
		updateThread: vi.fn(async () => {}),
		deleteThread: vi.fn(async () => {}),
		hideMessage: vi.fn(async () => {}),
		listMessages: vi.fn(async (): Promise<MessageView[]> => []),
		leave: vi.fn(async () => {}),
		replaceAvatar: vi.fn(async () => 0),
	};
	return client;
};

let connector: FakeConnector;
let client: ReturnType<typeof fakeClient>;
let bridge: Bridge;
let deliver: (frame: ServerFrame) => void;
let subscribed: string[];
let current: RegistrationView[];
let store: MemoryBridgeStore;

beforeEach(async () => {
	connector = new FakeConnector();
	current = [registration()];
	client = fakeClient(() => current);
	subscribed = [];
	store = new MemoryBridgeStore();
	bridge = new Bridge({
		client: client as unknown as ColibriClient,
		connector,
		store,
		sleep: async () => {},
		createEventStream: (options: EventStreamOptions) => {
			deliver = options.onFrame;
			return {
				start: () => {},
				stop: () => {},
				setChannels: (channels: Iterable<string>) => {
					subscribed = [...channels];
				},
			};
		},
	});
	await bridge.start();
});

const inboundMessage = (id: string, markdown: string, extra: Record<string, unknown> = {}) =>
	connector.context?.emit({
		type: "message",
		remoteSpace: GUILD,
		remoteRoom: ROOM,
		id,
		author: { id: "alice-1", name: "Alice" },
		markdown,
		...extra,
	});

describe("configuration", () => {
	it("subscribes to linked channels and reports the connector's rooms", () => {
		expect(subscribed).toEqual([CHANNEL]);
		expect(client.putRemoteRooms).toHaveBeenCalledWith(
			{ community: COMMUNITY, registration: REGISTRATION },
			[{ id: ROOM, name: "general" }],
		);
	});

	it("reloads when the AppView says a registration changed", async () => {
		current = [registration({ links: [] })];
		deliver({ $type: "social.colibri.beta.sync.defs#bridgeEvent", event: "update" });
		await bridge.idle();

		expect(client.getConfiguration).toHaveBeenCalledTimes(2);
		expect(subscribed).toEqual([]);
	});

	it("keeps trying to load its configuration until the AppView answers", async () => {
		const later = fakeClient(() => [registration()]);
		later.getConfiguration
			.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
			.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
		const retrying = new Bridge({
			client: later as unknown as ColibriClient,
			connector: new FakeConnector(),
			store: new MemoryBridgeStore(),
			sleep: async () => {},
			createEventStream: () => ({ start: () => {}, stop: () => {}, setChannels: () => {} }),
		});

		await retrying.start();

		expect(later.getConfiguration).toHaveBeenCalledTimes(3);
		expect(later.putRemoteRooms).toHaveBeenCalled();
	});

	it("purges what it stored for a registration that was revoked", async () => {
		inboundMessage("m1", "hello");
		await bridge.idle();
		expect(await store.registrations()).toEqual([`${COMMUNITY} ${REGISTRATION}`]);

		current = [];
		await bridge.refresh();

		expect(await store.registrations()).toEqual([]);
	});

	it("revokes its registrations for a remote space that removed it", async () => {
		client.leave.mockImplementation(async () => {
			current = [];
		});
		connector.context?.emit({ type: "spaceLeft", remoteSpace: GUILD });
		await vi.waitFor(() => expect(subscribed).toEqual([]));

		expect(client.leave).toHaveBeenCalledWith({
			community: COMMUNITY,
			registration: REGISTRATION,
		});
	});

	it("ignores registrations for other platforms", async () => {
		current = [registration({ platform: "elsewhere" })];
		await bridge.refresh();

		expect(subscribed).toEqual([]);
	});
});

describe("from the other service into Colibri", () => {
	it("posts a message with its markdown turned into facets", async () => {
		inboundMessage("m1", "hi **there**");
		await bridge.idle();

		expect(client.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				community: COMMUNITY,
				registration: REGISTRATION,
				channel: CHANNEL,
				author: { id: "alice-1", name: "Alice" },
				text: "hi there",
				remoteMessage: "m1",
				facets: [
					expect.objectContaining({
						index: expect.objectContaining({ byteStart: 3, byteEnd: 8 }),
					}),
				],
			}),
		);
	});

	it("posts a replayed message only once", async () => {
		inboundMessage("m1", "once");
		inboundMessage("m1", "once");
		await bridge.idle();

		expect(client.postMessage).toHaveBeenCalledTimes(1);
	});

	it("threads a reply onto the message it answers", async () => {
		inboundMessage("m1", "question");
		inboundMessage("m2", "answer", { replyTo: "m1" });
		await bridge.idle();

		const first = await client.postMessage.mock.results[0]?.value;
		expect(client.postMessage.mock.calls[1]?.[0]).toMatchObject({
			parent: { did: COMMUNITY, rkey: first.rkey },
		});
	});

	it("edits and deletes the messages it posted", async () => {
		inboundMessage("m1", "first");
		await bridge.idle();
		connector.context?.emit({
			type: "messageEdit",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "m1",
			markdown: "second",
		});
		connector.context?.emit({
			type: "messageDelete",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "m1",
		});
		await bridge.idle();

		expect(client.editMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "second" }));
		expect(client.deleteMessage).toHaveBeenCalledTimes(1);
	});

	it("ignores rooms that are not linked", async () => {
		connector.context?.emit({
			type: "message",
			remoteSpace: GUILD,
			remoteRoom: "room-unlinked",
			id: "m9",
			author: { id: "alice-1", name: "Alice" },
			markdown: "nobody hears this",
		});
		await bridge.idle();

		expect(client.postMessage).not.toHaveBeenCalled();
	});

	it("retries a request the AppView rate limited", async () => {
		client.postMessage.mockRejectedValueOnce(
			new ColibriRequestError(429, "RateLimited", "slow down", 1),
		);
		inboundMessage("m1", "eventually");
		await bridge.idle();

		expect(client.postMessage).toHaveBeenCalledTimes(2);
	});

	it("adds a reaction to a relayed message", async () => {
		inboundMessage("m1", "react to me");
		await bridge.idle();
		connector.context?.emit({
			type: "reactionAdd",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			messageId: "m1",
			author: { id: "bob-1", name: "Bob" },
			emoji: "👍",
		});
		await bridge.idle();

		const posted = await client.postMessage.mock.results[0]?.value;
		expect(client.addReaction).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { did: COMMUNITY, rkey: posted.rkey },
				author: { id: "bob-1", name: "Bob" },
				emoji: "👍",
			}),
		);
	});
});

describe("avatars", () => {
	const withAvatar = (id: string, avatarUrl?: string) =>
		inboundMessage(id, "hi", {
			author: { id: "alice-1", name: "Alice", ...(avatarUrl ? { avatarUrl } : {}) },
		});

	it("uploads an avatar once while it stays the same", async () => {
		withAvatar("m1", "https://cdn.test/a.png");
		withAvatar("m2", "https://cdn.test/a.png");
		await bridge.idle();

		expect(client.uploadBlob).toHaveBeenCalledTimes(1);
		expect(client.replaceAvatar).not.toHaveBeenCalled();
	});

	it("swaps the old avatar out of earlier records when it changes", async () => {
		withAvatar("m1", "https://cdn.test/a.png");
		await bridge.idle();
		client.uploadBlob.mockResolvedValueOnce({
			$type: "blob",
			ref: { $link: "bafynew" },
			mimeType: "image/png",
			size: 1,
		});
		withAvatar("m2", "https://cdn.test/b.png");
		await bridge.idle();

		expect(client.replaceAvatar).toHaveBeenCalledWith({
			community: COMMUNITY,
			registration: REGISTRATION,
			remoteId: "alice-1",
			avatar: expect.objectContaining({ ref: { $link: "bafynew" } }),
		});
	});

	it("removes the avatar from earlier records when the author drops it", async () => {
		withAvatar("m1", "https://cdn.test/a.png");
		await bridge.idle();
		withAvatar("m2");
		await bridge.idle();

		expect(client.replaceAvatar).toHaveBeenCalledWith({
			community: COMMUNITY,
			registration: REGISTRATION,
			remoteId: "alice-1",
		});
	});
});

describe("from Colibri to the other service", () => {
	const messageFrame = (event: "create" | "update", message: MessageView) =>
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event,
			channel: CHANNEL,
			message,
		});

	it("sends a Colibri message as markdown under the author's name", async () => {
		messageFrame("create", messageView());
		await bridge.idle();

		expect(connector.sent).toEqual([
			expect.objectContaining({
				remoteSpace: GUILD,
				remoteRoom: ROOM,
				author: { did: MEMBER, name: "Member", handle: "member.test" },
				markdown: "hello **bold**",
			}),
		]);
	});

	it("sends a message once even when its event arrives twice", async () => {
		messageFrame("create", messageView());
		messageFrame("create", messageView());
		await bridge.idle();

		expect(connector.sent).toHaveLength(1);
	});

	it("does not send a message another bridge imported from earlier history", async () => {
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView(),
			imported: true,
		});
		await bridge.idle();

		expect(connector.sent).toEqual([]);
	});

	it("does not send back a message it relayed itself", async () => {
		messageFrame(
			"create",
			messageView({
				author: {
					did: COMMUNITY,
					handle: "community.test",
					displayName: "Alice",
					isBot: true,
					bridge: { registration: REGISTRATION, platform: "test", remoteId: "alice-1" },
				},
			}),
		);
		await bridge.idle();

		expect(connector.sent).toEqual([]);
	});

	it("passes on a message another bridge relayed", async () => {
		messageFrame(
			"create",
			messageView({
				author: {
					did: COMMUNITY,
					handle: "community.test",
					displayName: "Carol",
					isBot: true,
					bridge: { registration: "3lkotherbridg", platform: "chat", remoteId: "carol" },
				},
			}),
		);
		await bridge.idle();

		expect(connector.sent).toHaveLength(1);
	});

	it("edits and deletes what it sent", async () => {
		messageFrame("create", messageView());
		await bridge.idle();
		messageFrame(
			"update",
			messageView({ text: "changed", facets: [], updatedAt: "2026-09-24T00:01:00.000Z" }),
		);
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "delete",
			channel: CHANNEL,
			subject: { did: MEMBER, rkey: "3lkmsg0000001" },
		});
		await bridge.idle();

		expect(connector.edits).toEqual([{ id: "remote-1", markdown: "changed" }]);
		expect(connector.deletes).toEqual(["remote-1"]);
	});

	it("reacts once per emoji and takes the reaction back when the last person does", async () => {
		messageFrame("create", messageView());
		await bridge.idle();
		const reaction = (event: "create" | "delete", actor: string) =>
			deliver({
				$type: "social.colibri.beta.sync.defs#reactionEvent",
				event,
				channel: CHANNEL,
				target: { did: MEMBER, rkey: "3lkmsg0000001" },
				emoji: "🎉",
				actor,
			});

		reaction("create", MEMBER);
		reaction("create", "did:plc:secondmemberxxxxxxxxxxxxxx");
		reaction("delete", MEMBER);
		await bridge.idle();
		expect(connector.reactions.map((entry) => entry.event)).toEqual(["add"]);

		reaction("delete", "did:plc:secondmemberxxxxxxxxxxxxxx");
		await bridge.idle();
		expect(connector.reactions.map((entry) => entry.event)).toEqual(["add", "remove"]);
	});
});

describe("pairing", () => {
	it("asks the AppView for a code under the connector's platform", async () => {
		const pairing = await connector.context?.pair({ remoteSpace: GUILD, remoteSpaceName: "Guild" });

		expect(pairing?.code).toBe("ABCD2345");
		expect(client.createPairing).toHaveBeenCalledWith({
			platform: "test",
			remoteSpace: GUILD,
			remoteSpaceName: "Guild",
		});
	});
});

const threadView = (overrides: Record<string, unknown> = {}) => ({
	space: THREAD,
	channel: CHANNEL,
	community: COMMUNITY,
	name: "Plans",
	createdBy: MEMBER,
	createdAt: "2026-09-24T00:00:00.000Z",
	lastActivityAt: "2026-09-24T00:00:00.000Z",
	messageCount: 0,
	participants: [],
	viewer: {},
	...overrides,
});

const threadFrame = (event: string, detail: Record<string, unknown>): ServerFrame => ({
	$type: "social.colibri.beta.sync.defs#threadEvent",
	event,
	community: COMMUNITY,
	...detail,
});

const relayed = async (id: string) => {
	inboundMessage(id, "anchor");
	await bridge.idle();
	const call = client.postMessage.mock.results.at(-1)?.value as Promise<{ rkey: string }>;
	return (await call).rkey;
};

describe("threads", () => {
	it("opens a thread on its first message, anchored on the message it grew from", async () => {
		const anchor = await relayed("m1");

		inboundMessage("m2", "first", { thread: { id: "t1", name: "Plans", anchor: "m1" } });
		inboundMessage("m3", "second", { thread: { id: "t1", name: "Plans", anchor: "m1" } });
		await bridge.idle();

		expect(client.createThread).toHaveBeenCalledTimes(1);
		expect(client.createThread).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: CHANNEL,
				name: "Plans",
				anchor: { did: COMMUNITY, rkey: anchor },
				remoteThread: "t1",
			}),
		);
		expect(client.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ channel: THREAD, text: "second" }),
		);
		expect(subscribed).toEqual([CHANNEL, THREAD]);
	});

	it("drops a message in a thread it has never seen opened", async () => {
		inboundMessage("m1", "lost", { remoteThread: "t9" });
		await bridge.idle();

		expect(client.postMessage).not.toHaveBeenCalled();
	});

	it("renames and deletes the threads it opened", async () => {
		connector.context?.emit({
			type: "threadCreate",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "t1",
			name: "Plans",
			author: { id: "alice-1", name: "Alice" },
		});
		connector.context?.emit({
			type: "threadUpdate",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "t1",
			name: "Better plans",
		});
		connector.context?.emit({
			type: "threadDelete",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "t1",
		});
		await bridge.idle();

		expect(client.updateThread).toHaveBeenCalledWith(
			expect.objectContaining({ thread: THREAD, name: "Better plans" }),
		);
		expect(client.deleteThread).toHaveBeenCalledWith(expect.objectContaining({ thread: THREAD }));
		expect(subscribed).toEqual([CHANNEL]);
	});

	it("opens a Colibri thread on the other service and sends what was already in it", async () => {
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView(),
		});
		await bridge.idle();
		client.listMessages.mockResolvedValueOnce([
			messageView({ rkey: "3lkmsg0000002", channel: THREAD, text: "early", facets: [] }),
		]);

		deliver(
			threadFrame("create", {
				channel: CHANNEL,
				thread: threadView({
					anchor: { space: CHANNEL, did: MEMBER, rkey: "3lkmsg0000001" },
				}),
			}),
		);
		await bridge.idle();

		expect(connector.threads).toEqual([
			{ remoteSpace: GUILD, remoteRoom: ROOM, name: "Plans", anchor: "remote-1" },
		]);
		expect(connector.sent.at(-1)).toMatchObject({
			remoteThread: "remote-thread-1",
			markdown: "early",
		});
		expect(subscribed).toEqual([CHANNEL, THREAD]);
	});

	it("leaves private threads and its own threads alone, and archives deleted ones", async () => {
		deliver(threadFrame("create", { channel: CHANNEL, thread: threadView({ private: true }) }));
		await bridge.idle();
		expect(connector.threads).toEqual([]);

		inboundMessage("m1", "hi", { thread: { id: "t1", name: "Plans" } });
		await bridge.idle();
		deliver(threadFrame("create", { channel: CHANNEL, thread: threadView() }));
		deliver(threadFrame("delete", { space: THREAD }));
		await bridge.idle();

		expect(connector.threads).toEqual([]);
		expect(connector.archived).toEqual([
			{ remoteSpace: GUILD, remoteRoom: ROOM, remoteThread: "t1", id: "t1" },
		]);
	});
});

describe("mentions", () => {
	it("turns remote references into channel and person mentions", async () => {
		inboundMessage(
			"m1",
			"[@Bob](bridge:user/bob-1) see [#general](bridge:room/room-1) [#x](bridge:room/9)",
		);
		await bridge.idle();

		const input = client.postMessage.mock.calls[0]?.[0];
		expect(input?.text).toBe("@Bob see #general #x");
		expect(input?.facets?.map((facet) => facet.features[0])).toEqual([
			{
				$type: "social.colibri.beta.richtext.facet#bridgedMention",
				registration: REGISTRATION,
				platform: "test",
				remoteId: "bob-1",
			},
			{ $type: "social.colibri.beta.richtext.facet#channel", channel: "3lkchannel001" },
		]);
	});

	it("sends mentions of bridged people and linked channels as references", async () => {
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView({
				text: "@Bob in #general",
				facets: [
					{
						index: { byteStart: 0, byteEnd: 4 },
						features: [
							{
								$type: "social.colibri.beta.richtext.facet#bridgedMention",
								registration: REGISTRATION,
								platform: "test",
								remoteId: "bob-1",
							},
						],
					},
					{
						index: { byteStart: 8, byteEnd: 16 },
						features: [
							{ $type: "social.colibri.beta.richtext.facet#channel", channel: "3lkchannel001" },
						],
					},
				],
			}),
		});
		await bridge.idle();

		expect(connector.sent[0]?.markdown).toBe(
			"[@Bob](bridge:user/bob-1) in [#general](bridge:room/room-1)",
		);
	});
});

describe("moderation", () => {
	const hide = (did: string, rkey: string) =>
		deliver({
			$type: "social.colibri.beta.sync.defs#labelEvent",
			event: "create",
			space: CHANNEL,
			subject: { did, collection: "social.colibri.beta.message", rkey },
			val: "hidden",
			src: COMMUNITY,
		});

	it("deletes its copy of a Colibri message a moderator hid", async () => {
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView(),
		});
		await bridge.idle();

		hide(MEMBER, "3lkmsg0000001");
		await bridge.idle();

		expect(connector.deletes).toEqual(["remote-1"]);
	});

	it("removes the original of a hidden message only when mirroring is on", async () => {
		const rkey = await relayed("m1");
		hide(COMMUNITY, rkey);
		await bridge.idle();
		expect(connector.removed).toEqual([]);

		current = [registration({ mirrorModeration: true })];
		await bridge.refresh();
		hide(COMMUNITY, rkey);
		await bridge.idle();

		expect(connector.removed).toEqual([{ remoteSpace: GUILD, remoteRoom: ROOM, id: "m1" }]);
	});

	it("hides a Colibri message when a moderator removes its copy, if mirroring is on", async () => {
		current = [registration({ mirrorModeration: true })];
		await bridge.refresh();
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView(),
		});
		await bridge.idle();

		connector.context?.emit({
			type: "messageDelete",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "remote-1",
		});
		await bridge.idle();

		expect(client.hideMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: CHANNEL,
				subject: { did: MEMBER, rkey: "3lkmsg0000001" },
			}),
		);
	});
});

describe("forwards", () => {
	it("forwards a relayed message and quotes one it never saw", async () => {
		const source = await relayed("m1");

		inboundMessage("m2", "", { forward: { remoteMessage: "m1", markdown: "anchor" } });
		inboundMessage("m3", "look", { forward: { remoteMessage: "elsewhere", markdown: "old news" } });
		await bridge.idle();

		expect(client.postMessage.mock.calls[1]?.[0]).toMatchObject({
			text: "",
			forward: { source: { space: CHANNEL, did: COMMUNITY, rkey: source }, text: "anchor" },
		});
		expect(client.postMessage.mock.calls[2]?.[0]).toMatchObject({ text: "look\n\nold news" });
		expect(client.postMessage.mock.calls[2]?.[0]).not.toHaveProperty("forward");
	});
});

describe("history import", () => {
	const SINCE = "2026-09-01T00:00:00.000Z";
	const REQUESTED = "2026-09-20T00:00:00.000Z";
	const at = (day: number, hour = 0) =>
		`2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
	const history = (id: string, createdAt: string, extra: Partial<HistoryMessage> = {}) => ({
		remoteSpace: GUILD,
		remoteRoom: ROOM,
		id,
		author: { id: "alice-1", name: "Alice" },
		markdown: `message ${id}`,
		createdAt,
		...extra,
	});

	class HistoryFake extends FakeConnector implements HistoryConnector {
		rooms: HistoryMessage[] = [];
		threadMessages = new Map<string, HistoryMessage[]>();
		threadList: HistoryThread[] = [];
		pageSize = 2;

		async fetchHistory(request: HistoryRequest) {
			const source = request.remoteThread
				? (this.threadMessages.get(request.remoteThread) ?? [])
				: this.rooms;
			const eligible = source.filter(
				(message) => !request.since || message.createdAt >= request.since,
			);
			const start = request.after
				? eligible.findIndex((message) => message.id === request.after) + 1
				: 0;
			return eligible.slice(start, start + this.pageSize);
		}
		async listThreads() {
			return this.threadList;
		}
		async roomCreatedAt() {
			return "2020-01-01T00:00:00.000Z";
		}
	}

	let history_: HistoryFake;
	let store: BridgeStore;

	const withHistory = (backfill: { since?: string; requestedAt: string }) =>
		registration({
			links: [
				{ channel: CHANNEL, remoteRoom: ROOM, remoteName: "general", backfill },
			] as RegistrationView["links"],
		});

	const importClient = () => {
		const importMessages = vi.fn(
			async (input: { channel: string; messages: Array<{ remoteMessage: string }> }) =>
				input.messages.map((message) => ({
					remoteMessage: message.remoteMessage,
					rkey: `3lkimp${message.remoteMessage}`,
				})),
		);
		const reportBackfill = vi.fn(async (_input: Record<string, unknown>) => {});
		return Object.assign(
			fakeClient(() => current),
			{ importMessages, reportBackfill },
		);
	};

	let importing: ReturnType<typeof importClient>;

	const run = async (connectorFor: HistoryFake = history_, batchSize = 25) => {
		const running = new Bridge({
			client: importing as unknown as ColibriClient,
			connector: connectorFor,
			store,
			sleep: async () => {},
			backfillBatchSize: batchSize,
			backfillReportIntervalMs: 0,
			createEventStream: () => ({ start: () => {}, stop: () => {}, setChannels: () => {} }),
		});
		await running.start();
		await running.idle();
		return running;
	};

	const imported = () =>
		importing.importMessages.mock.calls.map(([input]) => ({
			channel: input.channel,
			ids: input.messages.map((message) => message.remoteMessage),
		}));

	const lastReport = () => importing.reportBackfill.mock.calls.at(-1)?.[0];

	beforeEach(() => {
		history_ = new HistoryFake();
		store = new MemoryBridgeStore();
		importing = importClient();
		current = [withHistory({ since: SINCE, requestedAt: REQUESTED })];
	});

	it("imports oldest first and links replies to messages imported earlier", async () => {
		history_.rooms = [
			history("m1", at(2)),
			history("m2", at(3), { replyTo: "m1" }),
			history("m3", at(4)),
			history("m4", at(21)),
		];
		history_.pageSize = 10;

		await run();

		expect(imported()).toEqual([
			{ channel: CHANNEL, ids: ["m1"] },
			{ channel: CHANNEL, ids: ["m2", "m3"] },
		]);
		const second = importing.importMessages.mock.calls[1]?.[0] as unknown as {
			messages: Array<{ parent?: unknown; createdAt: string }>;
		};
		expect(second.messages[0]).toMatchObject({
			parent: { did: COMMUNITY, rkey: "3lkimpm1" },
			createdAt: at(3),
		});
		expect(lastReport()).toMatchObject({
			channel: CHANNEL,
			requestedAt: REQUESTED,
			state: "done",
			imported: 3,
			from: SINCE,
			until: REQUESTED,
			reached: at(4),
		});
	});

	it("skips messages the bridge already relayed", async () => {
		history_.rooms = [history("m1", at(2)), history("m2", at(3)), history("m3", at(4))];
		await store.put({
			registration: `${COMMUNITY} ${REGISTRATION}`,
			channel: CHANNEL,
			kind: "message",
			remoteId: "m2",
			rkey: `${CHANNEL} ${COMMUNITY} 3lklive`,
			origin: "remote",
		});

		await run();

		expect(imported().flatMap((call) => call.ids)).toEqual(["m1", "m3"]);
		expect(lastReport()).toMatchObject({ state: "done", imported: 2 });
	});

	it("imports a thread when the walk reaches it, before newer channel messages", async () => {
		history_.rooms = [history("m1", at(2)), history("m3", at(5))];
		history_.threadList = [
			{
				id: "t1",
				name: "Plans",
				anchor: "m1",
				author: { id: "bob-1", name: "Bob" },
				createdAt: at(3),
			},
		];
		history_.threadMessages.set("t1", [
			history("tm1", at(3, 1), { remoteThread: "t1" }),
			history("tm2", at(6), { remoteThread: "t1" }),
		]);

		await run();

		expect(importing.createThread).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: CHANNEL,
				name: "Plans",
				anchor: { did: COMMUNITY, rkey: "3lkimpm1" },
				remoteThread: "t1",
				createdAt: at(3),
			}),
		);
		expect(imported()).toEqual([
			{ channel: CHANNEL, ids: ["m1"] },
			{ channel: THREAD, ids: ["tm1", "tm2"] },
			{ channel: CHANNEL, ids: ["m3"] },
		]);
	});

	it("resumes from its stored cursor after a restart", async () => {
		history_.rooms = [history("m1", at(2)), history("m2", at(3)), history("m3", at(4))];
		await store.putBackfill(`${COMMUNITY} ${REGISTRATION} ${CHANNEL} ${REQUESTED}`, {
			state: "running",
			from: SINCE,
			until: REQUESTED,
			cursor: "m1",
			threadsDone: [],
			imported: 1,
			reached: at(2),
		});

		await run();

		expect(imported().flatMap((call) => call.ids)).toEqual(["m2", "m3"]);
		expect(lastReport()).toMatchObject({ state: "done", imported: 3 });
	});

	it("reports steady progress and runs again for a new request", async () => {
		history_.rooms = [history("m1", at(2)), history("m2", at(3)), history("m3", at(4))];

		const running = await run(history_, 1);
		const reached = importing.reportBackfill.mock.calls
			.map(([input]) => input.reached as string | undefined)
			.filter((value): value is string => Boolean(value));
		expect(reached).toEqual([...reached].sort());
		expect(reached.at(-1)).toBe(at(4));
		await running.stop();

		current = [withHistory({ requestedAt: "2026-09-22T00:00:00.000Z" })];
		importing.importMessages.mockClear();
		history_.rooms.push(history("m5", at(21)));
		await run();

		expect(imported().flatMap((call) => call.ids)).toEqual(["m5"]);
		expect(lastReport()).toMatchObject({
			requestedAt: "2026-09-22T00:00:00.000Z",
			from: "2020-01-01T00:00:00.000Z",
			state: "done",
		});
	});

	it("marks the import failed when the AppView refuses it", async () => {
		history_.rooms = [history("m1", at(2))];
		importing.importMessages.mockRejectedValueOnce(
			new ColibriRequestError(400, "OutsideBackfillRange", "outside", null),
		);

		await run();

		expect(lastReport()).toMatchObject({ state: "failed", imported: 0 });
	});
});
