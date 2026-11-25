import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "./bridge.js";
import {
	type ColibriClient,
	ColibriRequestError,
	type ListMessagesOptions,
	type MessageView,
	type PostMessageInput,
	type RegistrationView,
} from "./client.js";
import type {
	BridgeContext,
	Connector,
	HistoryConnector,
	HistoryMessage,
	HistoryRequest,
	HistoryThread,
	ModeratingConnector,
	OpenChannelDelete,
	OpenChannelEdit,
	OpenChannelMessage,
	OpenChannelReaction,
	OpenChannelsChange,
	OpenChannelThread,
	OpenDeletingConnector,
	OpenEditingConnector,
	OpenLifecycleConnector,
	OpenModeratingConnector,
	OpenReactingConnector,
	OpenThreadingConnector,
	OutboundDelete,
	OutboundEdit,
	OutboundEmbed,
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
const CHANNEL = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/3lkchannel001`;
const THREAD = `at:space/${COMMUNITY}/social.colibri.beta.channel.thread/3lkthread0001`;
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
	editEmbeds: OutboundEmbed[][] = [];
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
	async editMessage(edit: OutboundEdit) {
		this.edits.push({ id: edit.id, markdown: edit.markdown });
		this.editEmbeds.push(edit.embeds);
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
		fetchBytes: vi.fn(async (_url: string) => ({
			bytes: new Uint8Array([1]),
			mimeType: "image/png",
		})),
		createThread: vi.fn(async () => ({ thread: THREAD })),
		updateThread: vi.fn(async () => {}),
		deleteThread: vi.fn(async () => {}),
		hideMessage: vi.fn(async () => {}),
		listMessages: vi.fn(
			async (
				_channel: string,
				_options?: ListMessagesOptions,
			): Promise<{ messages: MessageView[]; cursor?: string }> => ({ messages: [] }),
		),
		listThreads: vi.fn(
			async (_input: {
				community: string;
				channel: string;
			}): Promise<{ threads: unknown[]; cursor?: string }> => ({ threads: [] }),
		),
		getMember: vi.fn(async (input: { did: string }) => ({
			did: input.did,
			member: true,
			owner: false,
			roles: [{ rkey: "3lkrole000001", name: "Helper", position: 1 }],
			permissions: ["messaging.send"],
		})),
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

	it("lists the communities a remote space is connected to", async () => {
		const other = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
		current = [
			registration({ communityName: "Birds" }),
			registration({ community: other, id: "3lkbridgebbbb", links: [] }),
		];
		await bridge.refresh();

		expect(connector.context?.connections(GUILD)).toEqual([
			{ community: COMMUNITY, communityName: "Birds", registration: REGISTRATION },
			{ community: other, registration: "3lkbridgebbbb" },
		]);
	});

	it("disconnects only the picked community when the remote side asks", async () => {
		const other = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
		current = [registration(), registration({ community: other, id: "3lkbridgebbbb" })];
		await bridge.refresh();

		const left = await connector.context?.disconnect(GUILD, other);

		expect(left).toBe(1);
		expect(client.leave).toHaveBeenCalledTimes(1);
		expect(client.leave).toHaveBeenCalledWith({ community: other, registration: "3lkbridgebbbb" });
	});

	it("disconnects every community of the remote space without a pick", async () => {
		const other = "did:plc:otherxxxxxxxxxxxxxxxxxxxxxxx";
		current = [registration(), registration({ community: other, id: "3lkbridgebbbb" })];
		await bridge.refresh();

		expect(await connector.context?.disconnect(GUILD)).toBe(2);
		expect(client.leave).toHaveBeenCalledTimes(2);
	});

	it("reports nothing to disconnect for an unknown community", async () => {
		expect(await connector.context?.disconnect(GUILD, "did:plc:nobodyxxxxxxxxxxxxxxxxxxxxx")).toBe(
			0,
		);
		expect(client.leave).not.toHaveBeenCalled();
	});

	it("treats a registration revoked in the meantime as disconnected", async () => {
		client.leave.mockRejectedValueOnce(
			new ColibriRequestError(400, "RegistrationNotFound", "gone", null),
		);

		await expect(connector.context?.disconnect(GUILD)).resolves.toBe(1);
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

	it("uploads attachments with their description and spoiler flag", async () => {
		inboundMessage("m1", "look", {
			attachments: [
				{ url: "https://cdn.test/a.png", name: "a.png", alt: "a cat", spoiler: true },
				{ url: "https://cdn.test/huge.png", size: 999_999_999 },
			],
		});
		await bridge.idle();

		expect(client.postMessage.mock.calls[0]?.[0].attachments).toEqual([
			{
				blob: expect.objectContaining({ $type: "blob" }),
				name: "a.png",
				alt: "a cat",
				spoiler: true,
			},
		]);
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

	it("sends attachment details and link previews, minus the ones the author suppressed", async () => {
		messageFrame(
			"create",
			messageView({
				attachments: [
					{
						url: "https://appview.test/blob/a",
						mimeType: "image/png",
						name: "a.png",
						size: 10,
						alt: "a cat",
						spoiler: true,
						width: 4,
						height: 3,
					},
				],
				embeds: [
					{ uri: "https://example.com", title: "Example", image: { url: "https://img.test/1" } },
					{ uri: "https://hidden.test", title: "Hidden" },
				],
				suppressedEmbeds: ["https://hidden.test"],
			}),
		);
		await bridge.idle();

		expect(connector.sent[0]?.attachments).toEqual([
			{
				url: "https://appview.test/blob/a",
				mimeType: "image/png",
				name: "a.png",
				size: 10,
				alt: "a cat",
				spoiler: true,
				width: 4,
				height: 3,
			},
		]);
		expect(connector.sent[0]?.embeds).toEqual([
			{ url: "https://example.com", title: "Example", imageUrl: "https://img.test/1" },
		]);
	});

	it("sends no link previews when the author suppressed them all", async () => {
		messageFrame(
			"create",
			messageView({
				embeds: [{ uri: "https://example.com", title: "Example" }],
				suppressedEmbeds: ["https://example.com"],
			}),
		);
		await bridge.idle();

		expect(connector.sent[0]?.embeds).toEqual([]);
	});

	it("sends link previews with an edit", async () => {
		messageFrame("create", messageView());
		await bridge.idle();
		messageFrame(
			"update",
			messageView({
				updatedAt: "2026-09-24T00:01:00.000Z",
				embeds: [{ uri: "https://example.com", siteName: "Example" }],
			}),
		);
		await bridge.idle();

		expect(connector.editEmbeds).toEqual([[{ url: "https://example.com", siteName: "Example" }]]);
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

const OPEN = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/3lkchannel002`;
const OPEN_THREAD = `at:space/${COMMUNITY}/social.colibri.beta.channel.thread/3lkthread0002`;

class FakeOpenConnector
	implements
		OpenEditingConnector,
		OpenDeletingConnector,
		OpenModeratingConnector,
		OpenReactingConnector,
		OpenThreadingConnector,
		OpenLifecycleConnector
{
	readonly platform = "test";
	context: BridgeContext | null = null;
	heard: OpenChannelMessage[] = [];
	edits: OpenChannelEdit[] = [];
	deletes: OpenChannelDelete[] = [];
	removed: OpenChannelDelete[] = [];
	reactions: Array<{ event: "add" | "remove"; reaction: OpenChannelReaction }> = [];
	threads: Array<{ event: "create" | "update" | "delete"; thread: Partial<OpenChannelThread> }> =
		[];
	changes: OpenChannelsChange[] = [];

	async start(context: BridgeContext) {
		this.context = context;
	}
	async stop() {}
	async openMessage(message: OpenChannelMessage) {
		this.heard.push(message);
	}
	async openEditMessage(edit: OpenChannelEdit) {
		this.edits.push(edit);
	}
	async openDeleteMessage(target: OpenChannelDelete) {
		this.deletes.push(target);
	}
	async openRemoveMessage(target: OpenChannelDelete) {
		this.removed.push(target);
	}
	async openAddReaction(reaction: OpenChannelReaction) {
		this.reactions.push({ event: "add", reaction });
	}
	async openRemoveReaction(reaction: OpenChannelReaction) {
		this.reactions.push({ event: "remove", reaction });
	}
	async openCreateThread(thread: OpenChannelThread) {
		this.threads.push({ event: "create", thread });
	}
	async openUpdateThread(thread: OpenChannelThread) {
		this.threads.push({ event: "update", thread });
	}
	async openDeleteThread(thread: Omit<OpenChannelThread, "name" | "anchor">) {
		this.threads.push({ event: "delete", thread });
	}
	async openChannelsChanged(change: OpenChannelsChange) {
		this.changes.push(change);
	}
}

describe("open channels", () => {
	let open: FakeOpenConnector;
	let openBridge: Bridge;
	let hear: (frame: ServerFrame) => void;
	let heardChannels: string[];

	const openRegistration = (overrides: Partial<RegistrationView> = {}) =>
		registration({ links: [], channels: [OPEN], ...overrides } as Partial<RegistrationView>);

	const openFrame = (
		event: "create" | "update",
		message: MessageView,
		extra: Record<string, unknown> = {},
	) =>
		hear({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event,
			channel: OPEN,
			message,
			...extra,
		});

	const deleteFrame = (did: string, rkey: string, channel = OPEN) =>
		hear({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "delete",
			channel,
			subject: { did, rkey },
		});

	const hiddenFrame = (did: string, rkey: string) =>
		hear({
			$type: "social.colibri.beta.sync.defs#labelEvent",
			event: "create",
			space: OPEN,
			subject: { did, collection: "social.colibri.beta.message", rkey },
			val: "hidden",
			src: COMMUNITY,
		});

	const bridgeOwnAuthor = {
		did: COMMUNITY,
		handle: "community.test",
		displayName: "Helper",
		isBot: true,
		bridge: { registration: REGISTRATION, platform: "test", remoteId: "bot" },
	};

	const startOpen = async (connector: Connector = open) => {
		const started = new Bridge({
			client: client as unknown as ColibriClient,
			connector,
			store: new MemoryBridgeStore(),
			sleep: async () => {},
			createEventStream: (options: EventStreamOptions) => {
				hear = options.onFrame;
				return {
					start: () => {},
					stop: () => {},
					setChannels: (channels: Iterable<string>) => {
						heardChannels = [...channels];
					},
				};
			},
		});

		await started.start();

		return started;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		open = new FakeOpenConnector();
		current = [openRegistration()];
		heardChannels = [];
		openBridge = await startOpen();
	});

	it("constructs and runs with a connector that only handles open channels", () => {
		expect(heardChannels).toEqual([OPEN]);
		expect(client.putRemoteRooms).not.toHaveBeenCalled();
		expect(open.context?.openChannels(COMMUNITY, REGISTRATION)).toEqual([OPEN]);
	});

	it("refuses a connector that neither relays nor handles open channels", () => {
		const neither = { platform: "test", start: async () => {}, stop: async () => {} };

		expect(
			() =>
				new Bridge({
					client: client as unknown as ColibriClient,
					connector: neither,
					store: new MemoryBridgeStore(),
				}),
		).toThrow(/neither relays rooms nor handles open channels/);
	});

	it("ignores remote room events for an open-only connector", async () => {
		open.context?.emit({
			type: "message",
			remoteSpace: GUILD,
			remoteRoom: ROOM,
			id: "m1",
			author: { id: "alice-1", name: "Alice" },
			markdown: "hi",
		});
		await openBridge.idle();

		expect(client.postMessage).not.toHaveBeenCalled();
	});

	it("hands new messages to the connector with the author's standing and content", async () => {
		openFrame(
			"create",
			messageView({
				channel: OPEN,
				author: {
					did: MEMBER,
					handle: "member.test",
					displayName: "Member",
					isBot: false,
					avatar: "https://cdn.test/member.png",
				},
				parent: {
					uri: "at://x",
					rkey: "3lkmsg0000000",
					author: { did: "did:plc:parentxxxxxxxxxxxxxxxxxxxxx" },
				},
				attachments: [
					{
						url: "https://appview.test/blob/a",
						mimeType: "image/png",
						name: "a.png",
						size: 10,
						alt: "a cat",
						spoiler: true,
						width: 4,
						height: 3,
					},
				],
				embeds: [
					{
						uri: "https://example.com",
						title: "Example",
						image: { url: "https://appview.test/img/1" },
						themeColor: "#ff0000",
					},
				],
				forward: {
					source: { space: CHANNEL, did: MEMBER, rkey: "3lkmsg0000009" },
					createdAt: "2026-09-23T00:00:00.000Z",
					text: "old",
					attachments: [],
				},
				updatedAt: "2026-09-24T00:02:00.000Z",
			}),
		);
		await openBridge.idle();

		expect(open.heard).toEqual([
			{
				community: COMMUNITY,
				registration: REGISTRATION,
				channel: OPEN,
				did: MEMBER,
				rkey: "3lkmsg0000001",
				author: {
					did: MEMBER,
					name: "Member",
					handle: "member.test",
					avatarUrl: "https://cdn.test/member.png",
					standing: {
						did: MEMBER,
						member: true,
						owner: false,
						roles: [{ rkey: "3lkrole000001", name: "Helper", position: 1 }],
						permissions: ["messaging.send"],
					},
				},
				markdown: "hello **bold**",
				replyTo: { did: "did:plc:parentxxxxxxxxxxxxxxxxxxxxx", rkey: "3lkmsg0000000" },
				attachments: [
					{
						url: "https://appview.test/blob/a",
						mimeType: "image/png",
						name: "a.png",
						size: 10,
						alt: "a cat",
						spoiler: true,
						width: 4,
						height: 3,
					},
				],
				embeds: [
					{
						url: "https://example.com",
						title: "Example",
						imageUrl: "https://appview.test/img/1",
						themeColor: "#ff0000",
					},
				],
				forward: {
					markdown: "old",
					attachments: [],
					source: { channel: CHANNEL, did: MEMBER, rkey: "3lkmsg0000009" },
				},
				createdAt: "2026-09-24T00:00:00.000Z",
				updatedAt: "2026-09-24T00:02:00.000Z",
			},
		]);
		expect(client.getMember).toHaveBeenCalledWith({
			community: COMMUNITY,
			registration: REGISTRATION,
			did: MEMBER,
			channel: OPEN,
		});
	});

	it("routes edits and deletes", async () => {
		openFrame("update", messageView({ channel: OPEN, text: "changed", facets: [] }));
		deleteFrame(MEMBER, "3lkmsg0000001");
		await openBridge.idle();

		expect(open.edits).toEqual([
			expect.objectContaining({ rkey: "3lkmsg0000001", markdown: "changed" }),
		]);
		expect(open.deletes).toEqual([
			{
				community: COMMUNITY,
				registration: REGISTRATION,
				channel: OPEN,
				did: MEMBER,
				rkey: "3lkmsg0000001",
			},
		]);
	});

	it("skips imported history and the messages it posted itself", async () => {
		openFrame("create", messageView({ channel: OPEN }), { imported: true });
		openFrame("create", messageView({ channel: OPEN, author: bridgeOwnAuthor }));
		openFrame("update", messageView({ channel: OPEN, author: bridgeOwnAuthor }));
		await openBridge.idle();

		expect(open.heard).toEqual([]);
		expect(open.edits).toEqual([]);
	});

	it("caches the author's standing", async () => {
		openFrame("create", messageView({ channel: OPEN }));
		openFrame("create", messageView({ channel: OPEN, rkey: "3lkmsg0000002" }));
		await openBridge.idle();

		expect(open.heard).toHaveLength(2);
		expect(client.getMember).toHaveBeenCalledTimes(1);
	});

	it("falls back to no standing when the AppView can't say", async () => {
		client.getMember.mockRejectedValueOnce(new Error("boom"));
		openFrame("create", messageView({ channel: OPEN }));
		await openBridge.idle();

		expect(open.heard[0]?.author.standing).toEqual({
			did: MEMBER,
			member: false,
			owner: false,
			roles: [],
			permissions: [],
		});
	});

	it("routes reactions with their custom emoji and skips the ones it added", async () => {
		const reaction = (event: "create" | "delete", extra: Record<string, unknown> = {}) =>
			hear({
				$type: "social.colibri.beta.sync.defs#reactionEvent",
				event,
				channel: OPEN,
				target: { did: MEMBER, rkey: "3lkmsg0000001" },
				emoji: ":party:",
				actor: MEMBER,
				customEmoji: { uri: `at://${MEMBER}/social.colibri.beta.emoji/party`, cid: "bafy" },
				...extra,
			});

		reaction("create");
		reaction("delete");
		reaction("create", {
			actor: COMMUNITY,
			bridged: { registration: REGISTRATION, platform: "test", remoteId: "bob", name: "Bob" },
		});
		await openBridge.idle();

		const expected = {
			community: COMMUNITY,
			registration: REGISTRATION,
			channel: OPEN,
			did: MEMBER,
			rkey: "3lkmsg0000001",
			emoji: ":party:",
			actor: MEMBER,
			customEmoji: { uri: `at://${MEMBER}/social.colibri.beta.emoji/party` },
		};
		expect(open.reactions).toEqual([
			{ event: "add", reaction: expected },
			{ event: "remove", reaction: expected },
		]);
	});

	it("tells the connector when a moderator hides a message", async () => {
		hiddenFrame(MEMBER, "3lkmsg0000001");
		await openBridge.idle();

		expect(open.removed).toEqual([
			{
				community: COMMUNITY,
				registration: REGISTRATION,
				channel: OPEN,
				did: MEMBER,
				rkey: "3lkmsg0000001",
			},
		]);
	});

	it("subscribes to threads under open channels and routes their events", async () => {
		const openThread = threadView({ space: OPEN_THREAD, channel: OPEN, name: "Help" });

		hear(threadFrame("create", { channel: OPEN, thread: openThread }));
		await openBridge.idle();
		expect(heardChannels).toEqual([OPEN, OPEN_THREAD]);

		hear({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: OPEN_THREAD,
			message: messageView({ channel: OPEN_THREAD }),
		});
		hear(threadFrame("update", { channel: OPEN, thread: { ...openThread, name: "Solved" } }));
		hear(threadFrame("delete", { channel: OPEN, space: OPEN_THREAD }));
		await openBridge.idle();

		expect(open.heard).toEqual([
			expect.objectContaining({ channel: OPEN, thread: OPEN_THREAD, rkey: "3lkmsg0000001" }),
		]);
		const ref = { community: COMMUNITY, registration: REGISTRATION, channel: OPEN };
		expect(open.threads).toEqual([
			{ event: "create", thread: { ...ref, thread: OPEN_THREAD, name: "Help" } },
			{ event: "update", thread: { ...ref, thread: OPEN_THREAD, name: "Solved" } },
			{ event: "delete", thread: { ...ref, thread: OPEN_THREAD } },
		]);
		expect(heardChannels).toEqual([OPEN]);
	});

	it("subscribes to the existing threads of open channels when it loads", async () => {
		client.listThreads.mockResolvedValueOnce({
			threads: [threadView({ space: OPEN_THREAD, channel: OPEN })],
		});
		await openBridge.refresh();

		expect(client.listThreads).toHaveBeenLastCalledWith(
			expect.objectContaining({ community: COMMUNITY, channel: OPEN }),
		);
		expect(heardChannels).toEqual([OPEN, OPEN_THREAD]);
	});

	it("keeps going when the existing threads can't be listed", async () => {
		client.listThreads.mockRejectedValueOnce(new Error("Forbidden"));
		await openBridge.refresh();

		expect(heardChannels).toEqual([OPEN]);
	});

	it("reports installed, updated and removed registrations after the first load", async () => {
		const SECOND = `at:space/${COMMUNITY}/social.colibri.beta.channel.text/3lkchannel003`;
		const other = "3lkbridgebbbb";

		expect(open.changes).toEqual([]);

		current = [
			openRegistration({ channels: [OPEN, SECOND] } as Partial<RegistrationView>),
			openRegistration({ id: other }),
		];
		await openBridge.refresh();
		await openBridge.idle();

		expect(open.changes).toEqual([
			{
				community: COMMUNITY,
				registration: REGISTRATION,
				kind: "updated",
				channels: [OPEN, SECOND],
				added: [SECOND],
				removed: [],
			},
			{
				community: COMMUNITY,
				registration: other,
				kind: "installed",
				channels: [OPEN],
				added: [OPEN],
				removed: [],
			},
		]);

		current = [openRegistration({ channels: [OPEN, SECOND] } as Partial<RegistrationView>)];
		await openBridge.refresh();
		current = [];
		await openBridge.refresh();
		await openBridge.idle();

		expect(open.changes.slice(2)).toEqual([
			{
				community: COMMUNITY,
				registration: other,
				kind: "removed",
				channels: [],
				added: [],
				removed: [OPEN],
			},
			{
				community: COMMUNITY,
				registration: REGISTRATION,
				kind: "removed",
				channels: [],
				added: [],
				removed: [OPEN, SECOND],
			},
		]);
	});

	it("stops listening to the open channels of a paused registration", async () => {
		current = [openRegistration({ enabled: false })];
		await openBridge.refresh();
		openFrame("create", messageView({ channel: OPEN }));
		await openBridge.idle();

		expect(heardChannels).not.toContain(OPEN);
		expect(open.heard).toEqual([]);
		expect(open.changes).toEqual([expect.objectContaining({ kind: "removed" })]);
	});

	it("leaves open channels alone for a connector that doesn't handle them", async () => {
		current = [registration({ channels: [OPEN] } as Partial<RegistrationView>)];
		await bridge.refresh();

		expect(subscribed).toEqual([CHANNEL]);
	});

	describe("openEmit", () => {
		const ref = { community: COMMUNITY, registration: REGISTRATION, channel: OPEN };

		it("posts a message with avatar, attachments, a reply and a forward", async () => {
			client.fetchBytes.mockImplementation(async (url: string) => {
				if (url.includes("broken")) throw new Error("404");
				return { bytes: new Uint8Array([1]), mimeType: "image/png" };
			});

			const result = await open.context?.openEmit({
				...ref,
				type: "message",
				author: { id: "bot", name: "Helper", avatarUrl: "https://cdn.test/bot.png" },
				markdown: "done **now**",
				replyTo: { did: MEMBER, rkey: "3lkmsg0000001" },
				attachments: [
					{ url: "https://cdn.test/a.png", name: "a.png", alt: "a cat", spoiler: true },
					{ url: "https://cdn.test/broken.png" },
					{ url: "https://cdn.test/huge.png", size: 999_999_999 },
				],
				forward: {
					markdown: "old",
					source: { channel: CHANNEL, did: MEMBER, rkey: "3lkmsg0000009" },
					createdAt: "2026-09-23T00:00:00.000Z",
				},
			});

			expect(result).toEqual({
				rkey: expect.stringMatching(/^3lkposted/),
				dropped: [
					{ url: "https://cdn.test/broken.png", reason: "fetchFailed" },
					{ url: "https://cdn.test/huge.png", size: 999_999_999, reason: "tooLarge" },
				],
			});
			expect(client.postMessage).toHaveBeenLastCalledWith({
				community: COMMUNITY,
				registration: REGISTRATION,
				channel: OPEN,
				author: {
					id: "bot",
					name: "Helper",
					avatar: expect.objectContaining({ $type: "blob" }),
				},
				text: "done now",
				facets: [
					expect.objectContaining({
						index: expect.objectContaining({ byteStart: 5, byteEnd: 8 }),
					}),
				],
				parent: { did: MEMBER, rkey: "3lkmsg0000001" },
				attachments: [
					{
						blob: expect.objectContaining({ $type: "blob" }),
						name: "a.png",
						alt: "a cat",
						spoiler: true,
					},
				],
				forward: {
					source: { space: CHANNEL, did: MEMBER, rkey: "3lkmsg0000009" },
					createdAt: "2026-09-23T00:00:00.000Z",
					text: "old",
				},
			});
			expect(client.fetchBytes).toHaveBeenCalledWith("https://cdn.test/bot.png");
		});

		it("uploads an author's avatar once", async () => {
			const post = () =>
				open.context?.openEmit({
					...ref,
					type: "message",
					author: { id: "bot", name: "Helper", avatarUrl: "https://cdn.test/bot.png" },
					markdown: "hi",
				});

			await post();
			await post();

			expect(client.uploadBlob).toHaveBeenCalledTimes(1);
		});

		it("posts into a thread of an open channel", async () => {
			hear(
				threadFrame("create", {
					channel: OPEN,
					thread: threadView({ space: OPEN_THREAD, channel: OPEN }),
				}),
			);
			await openBridge.idle();

			await open.context?.openEmit({
				...ref,
				thread: OPEN_THREAD,
				type: "message",
				author: { id: "bot", name: "Helper" },
				markdown: "in thread",
			});

			expect(client.postMessage).toHaveBeenLastCalledWith(
				expect.objectContaining({ channel: OPEN_THREAD, text: "in thread" }),
			);
		});

		it("edits, deletes and reacts, and skips the echoes", async () => {
			await open.context?.openEmit({
				...ref,
				type: "messageEdit",
				rkey: "3lkmine000001",
				markdown: "*new*",
			});
			const deleted = await open.context?.openEmit({
				...ref,
				type: "messageDelete",
				rkey: "3lkmine000001",
			});
			const reacted = await open.context?.openEmit({
				...ref,
				type: "reactionAdd",
				did: MEMBER,
				rkey: "3lkmsg0000001",
				author: { id: "bot", name: "Helper" },
				emoji: "👍",
			});
			await open.context?.openEmit({ ...ref, type: "reactionRemove", rkey: reacted?.rkey ?? "" });

			expect(client.editMessage).toHaveBeenCalledWith({
				...ref,
				rkey: "3lkmine000001",
				text: "new",
				facets: [expect.anything()],
			});
			expect(deleted).toEqual({ rkey: "3lkmine000001", dropped: [] });
			expect(client.deleteMessage).toHaveBeenCalledWith({ ...ref, rkey: "3lkmine000001" });
			expect(client.addReaction).toHaveBeenCalledWith({
				...ref,
				author: { id: "bot", name: "Helper" },
				target: { did: MEMBER, rkey: "3lkmsg0000001" },
				emoji: "👍",
			});
			expect(reacted?.rkey).toMatch(/^3lkreact/);
			expect(client.removeReaction).toHaveBeenCalledWith({ ...ref, rkey: reacted?.rkey });

			deleteFrame(COMMUNITY, "3lkmine000001");
			deleteFrame(MEMBER, "3lkmsg0000001");
			await openBridge.idle();

			expect(open.deletes).toEqual([
				expect.objectContaining({ did: MEMBER, rkey: "3lkmsg0000001" }),
			]);
		});

		it("removes a message only when mirroring is on, and skips the echo", async () => {
			await expect(
				open.context?.openEmit({
					...ref,
					type: "messageRemove",
					did: MEMBER,
					rkey: "3lkmsg0000001",
				}),
			).rejects.toThrow(/mirrorModeration/);
			expect(client.hideMessage).not.toHaveBeenCalled();

			current = [openRegistration({ mirrorModeration: true })];
			await openBridge.refresh();
			await open.context?.openEmit({
				...ref,
				type: "messageRemove",
				did: MEMBER,
				rkey: "3lkmsg0000001",
				reason: "spam",
			});

			expect(client.hideMessage).toHaveBeenCalledWith({
				...ref,
				subject: { did: MEMBER, rkey: "3lkmsg0000001" },
				reason: "spam",
			});

			hiddenFrame(MEMBER, "3lkmsg0000001");
			await openBridge.idle();

			expect(open.removed).toEqual([]);
		});

		it("creates, renames and deletes threads, and subscribes to new ones", async () => {
			client.createThread.mockResolvedValueOnce({ thread: OPEN_THREAD });

			const created = await open.context?.openEmit({
				...ref,
				type: "threadCreate",
				name: "Ticket",
				author: { id: "bot", name: "Helper" },
				anchor: { did: MEMBER, rkey: "3lkmsg0000001" },
			});

			expect(created).toEqual({ thread: OPEN_THREAD, dropped: [] });
			expect(client.createThread).toHaveBeenCalledWith({
				...ref,
				name: "Ticket",
				author: { id: "bot", name: "Helper" },
				anchor: { did: MEMBER, rkey: "3lkmsg0000001" },
			});
			expect(heardChannels).toEqual([OPEN, OPEN_THREAD]);

			hear(
				threadFrame("create", {
					channel: OPEN,
					thread: threadView({
						space: OPEN_THREAD,
						channel: OPEN,
						name: "Ticket",
						createdBy: COMMUNITY,
					}),
				}),
			);
			await openBridge.idle();
			expect(open.threads).toEqual([]);

			await open.context?.openEmit({
				...ref,
				type: "threadUpdate",
				thread: OPEN_THREAD,
				name: "Closed",
			});
			await open.context?.openEmit({ ...ref, type: "threadDelete", thread: OPEN_THREAD });

			expect(client.updateThread).toHaveBeenCalledWith({
				community: COMMUNITY,
				registration: REGISTRATION,
				thread: OPEN_THREAD,
				name: "Closed",
			});
			expect(client.deleteThread).toHaveBeenCalledWith({
				community: COMMUNITY,
				registration: REGISTRATION,
				thread: OPEN_THREAD,
			});
			expect(heardChannels).toEqual([OPEN]);
		});

		it("refuses a channel or thread that is not open", async () => {
			await expect(
				open.context?.openEmit({
					...ref,
					channel: CHANNEL,
					type: "message",
					author: { id: "bot", name: "Helper" },
					markdown: "hi",
				}),
			).rejects.toThrow(/is not an open channel/);
			await expect(
				open.context?.openEmit({
					...ref,
					thread: OPEN_THREAD,
					type: "messageDelete",
					rkey: "3lkmine000001",
				}),
			).rejects.toThrow(/is not a thread of the open channel/);
			expect(client.postMessage).not.toHaveBeenCalled();
		});

		it("throws what the AppView refuses after retrying rate limits", async () => {
			client.deleteMessage
				.mockRejectedValueOnce(new ColibriRequestError(429, "RateLimited", "slow down", 1))
				.mockRejectedValueOnce(new ColibriRequestError(403, "Forbidden", "not yours", null));

			await expect(
				open.context?.openEmit({ ...ref, type: "messageDelete", rkey: "3lkmsg0000001" }),
			).rejects.toThrow("not yours");
			expect(client.deleteMessage).toHaveBeenCalledTimes(2);
		});
	});

	describe("reading", () => {
		const ref = { community: COMMUNITY, registration: REGISTRATION, channel: OPEN };

		it("looks up one message by its author and record key", async () => {
			client.listMessages.mockResolvedValueOnce({
				messages: [
					messageView({ channel: OPEN, rkey: "3lkmsg0000002" }),
					messageView({ channel: OPEN }),
				],
			});

			const found = await open.context?.message({ ...ref, did: MEMBER, rkey: "3lkmsg0000001" });

			expect(client.listMessages).toHaveBeenCalledWith(OPEN, {
				around: "3lkmsg0000001",
				limit: expect.any(Number),
			});
			expect(found).toMatchObject({ rkey: "3lkmsg0000001", markdown: "hello **bold**" });
		});

		it("answers null for a message it can't find", async () => {
			expect(
				await open.context?.message({ ...ref, did: MEMBER, rkey: "3lkmsg0000001" }),
			).toBeNull();
		});

		it("pages history newest first from before a message", async () => {
			client.listMessages
				.mockResolvedValueOnce({
					messages: [
						messageView({ channel: OPEN, rkey: "3lkmsg0000005" }),
						messageView({ channel: OPEN, rkey: "3lkmsg0000004" }),
						messageView({ channel: OPEN, rkey: "3lkmsg0000003" }),
					],
					cursor: "next",
				})
				.mockResolvedValueOnce({
					messages: [messageView({ channel: OPEN, rkey: "3lkmsg0000002" })],
				});

			const history = await open.context?.history({ ...ref, before: "3lkmsg0000004", limit: 3 });

			expect(history?.map((message) => message.rkey)).toEqual(["3lkmsg0000003", "3lkmsg0000002"]);
			expect(client.listMessages).toHaveBeenNthCalledWith(1, OPEN, {
				around: "3lkmsg0000004",
				limit: 3,
			});
			expect(client.listMessages).toHaveBeenNthCalledWith(2, OPEN, { cursor: "next", limit: 2 });
		});

		it("answers a member's standing", async () => {
			expect(await open.context?.member({ ...ref, did: MEMBER })).toMatchObject({ member: true });
		});
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
		client.listMessages.mockResolvedValueOnce({
			messages: [
				messageView({ rkey: "3lkmsg0000002", channel: THREAD, text: "early", facets: [] }),
			],
		});

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

	it("turns time references into time facets", async () => {
		inboundMessage("m1", "meet [noon](bridge:time/1700000000:time-short)");
		await bridge.idle();

		const input = client.postMessage.mock.calls[0]?.[0];
		expect(input?.text).toBe("meet noon");
		expect(input?.facets).toMatchObject([
			{
				index: { byteStart: 5, byteEnd: 9 },
				features: [
					{
						$type: "social.colibri.beta.richtext.facet#time",
						datetime: "2023-11-14T22:13:20.000Z",
						style: "time-short",
					},
				],
			},
		]);
	});

	it("drops time references it cannot read", async () => {
		inboundMessage("m1", "meet [noon](bridge:time/1700000000:fortnightly)");
		await bridge.idle();

		const input = client.postMessage.mock.calls[0]?.[0];
		expect(input?.text).toBe("meet noon");
		expect(input?.facets ?? []).toEqual([]);
	});

	it("sends time facets as time references", async () => {
		deliver({
			$type: "social.colibri.beta.sync.defs#messageEvent",
			event: "create",
			channel: CHANNEL,
			message: messageView({
				text: "meet in 3 hours or at 4 PM",
				facets: [
					{
						index: { byteStart: 5, byteEnd: 15 },
						features: [
							{
								$type: "social.colibri.beta.richtext.facet#time",
								datetime: "2023-11-14T22:13:20.500Z",
							},
						],
					},
					{
						index: { byteStart: 22, byteEnd: 26 },
						features: [
							{
								$type: "social.colibri.beta.richtext.facet#time",
								datetime: "2023-11-14T16:00:00.000Z",
								style: "time-short",
							},
						],
					},
				],
			}),
		});
		await bridge.idle();

		expect(connector.sent[0]?.markdown).toBe(
			"meet [in 3 hours](bridge:time/1700000000:relative) or at [4 PM](bridge:time/1699977600:time-short)",
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
