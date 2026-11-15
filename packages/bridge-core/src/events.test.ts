import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { ColibriClient } from "./client.js";
import { EventStream, type EventStreamOptions, type ServerFrame } from "./events.js";

class FakeSocket extends EventEmitter {
	readonly sent: ServerFrame[] = [];

	readyState = 0;
	closedWith: [number, string] | null = null;

	constructor(readonly url: string) {
		super();
	}

	open(): void {
		this.readyState = 1;
		this.emit("open");
	}

	receive(frame: ServerFrame): void {
		this.emit("message", Buffer.from(JSON.stringify(frame)));
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as ServerFrame);
	}

	close(code: number, reason: string): void {
		if (this.readyState === 3) return;
		this.closedWith = [code, reason];
		this.readyState = 3;
		this.emit("close", code, Buffer.from(reason));
	}
}

const HEL = "https://hel-1.nodes.colibri.test";
const LAU = "https://lau-1.nodes.colibri.test";
const STEERING = "https://spaces-api.colibri.test";
const CHANNEL = "at://did:plc:space/channel/general";

const frame = (kind: string, fields: Record<string, unknown> = {}): ServerFrame => {
	return { $type: `social.colibri.beta.sync.defs#${kind}`, ...fields };
};

const drain = frame("drainNotice", { deadline: "2099-01-01T00:00:00.000Z", reason: "update" });

const directory = (endpoints: string[]) => {
	return {
		refresh: vi.fn(async () => {}),
		refreshIfStale: vi.fn(async () => {}),
		endpointFor: (_role: string, avoid?: ReadonlySet<string>) =>
			endpoints.find((endpoint) => !avoid?.has(endpoint)) ?? null,
	};
};

let sockets: FakeSocket[];
let frames: ServerFrame[];
let closes: string[];
let client: ColibriClient & { setWriteMode: ReturnType<typeof vi.fn> };
let stream: EventStream;

const start = async (options: Partial<EventStreamOptions> = {}) => {
	stream = new EventStream({
		client,
		onFrame: (received) => frames.push(received),
		onClose: (reason) => closes.push(reason),
		createSocket: (url) => {
			const socket = new FakeSocket(url);

			sockets.push(socket);

			return socket as unknown as WebSocket;
		},
		...options,
	});
	stream.setChannels([CHANNEL]);
	stream.start();
	await vi.advanceTimersByTimeAsync(0);
};

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	sockets = [];
	frames = [];
	closes = [];
	client = {
		appviewUrl: STEERING,
		token: async () => "token",
		setWriteMode: vi.fn(),
	} as unknown as ColibriClient & { setWriteMode: ReturnType<typeof vi.fn> };
});

afterEach(() => {
	stream.stop();
	vi.useRealTimers();
});

describe("EventStream", () => {
	it("connects to the fastest live node", async () => {
		await start({ nodes: directory([HEL, LAU]) });

		expect(sockets[0]?.url).toBe(
			"wss://hel-1.nodes.colibri.test/xrpc/social.colibri.beta.sync.subscribeEvents",
		);
	});

	it("falls back to the AppView host without a node directory", async () => {
		await start({ nodes: null });

		expect(sockets[0]?.url).toBe(
			"wss://spaces-api.colibri.test/xrpc/social.colibri.beta.sync.subscribeEvents",
		);
	});

	it("moves to another node before leaving a draining one", async () => {
		await start({ nodes: directory([LAU, HEL]) });

		const [lau] = sockets;

		lau?.open();
		lau?.receive(drain);
		await settle();

		const hel = sockets[1];

		expect(hel?.url).toContain("hel-1");
		expect(lau?.closedWith).toBeNull();

		hel?.open();

		expect(hel?.sent).toContainEqual(frame("subscribe", { channels: [CHANNEL] }));

		lau?.receive(frame("messageEvent", { event: "create", channel: CHANNEL, n: 1 }));
		hel?.receive(frame("subscribed", { channels: [CHANNEL] }));
		lau?.receive(frame("messageEvent", { event: "create", channel: CHANNEL, n: 2 }));
		hel?.receive(frame("messageEvent", { event: "create", channel: CHANNEL, n: 2 }));
		hel?.receive(frame("messageEvent", { event: "create", channel: CHANNEL, n: 3 }));

		expect(frames.map((received) => received.n)).toEqual([1, 2, 3]);
		expect(stream.endpoint).toBe(HEL);

		await vi.advanceTimersByTimeAsync(2_000);

		expect(lau?.closedWith).toEqual([1000, "moved to another node"]);
	});

	it("tries another node when the next one is draining too", async () => {
		await start({ nodes: directory([LAU, HEL, "https://stl-1.nodes.colibri.test"]) });

		sockets[0]?.open();
		sockets[0]?.receive(drain);
		await settle();
		sockets[1]?.open();
		sockets[1]?.receive(drain);

		expect(sockets[1]?.closedWith).toEqual([1000, "node draining"]);

		await vi.advanceTimersByTimeAsync(5_000);

		expect(sockets[2]?.url).toContain("stl-1");
		expect(sockets[0]?.closedWith).toBeNull();
	});

	it("tries the AppView host when no other node is listed and backs off if it lands back", async () => {
		await start({ nodes: directory([LAU]) });

		sockets[0]?.open();
		sockets[0]?.receive(drain);
		await settle();

		expect(sockets[1]?.url).toContain("spaces-api");

		sockets[1]?.open();
		sockets[1]?.receive(drain);

		expect(sockets[1]?.closedWith).toEqual([1000, "node draining"]);

		await vi.advanceTimersByTimeAsync(4_999);

		expect(sockets).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);

		expect(sockets[2]?.url).toContain("spaces-api");
		expect(sockets[0]?.closedWith).toBeNull();
	});

	it("reconnects through the AppView host on a drain without a node directory", async () => {
		await start({ nodes: null });

		sockets[0]?.open();
		sockets[0]?.receive(drain);
		await settle();

		expect(sockets[1]?.url).toContain("spaces-api");

		sockets[1]?.open();
		sockets[1]?.receive(frame("subscribed", { channels: [CHANNEL] }));
		await vi.advanceTimersByTimeAsync(2_000);

		expect(sockets[0]?.closedWith).toEqual([1000, "moved to another node"]);
	});

	it("follows the write state of the node it uses", async () => {
		await start({ nodes: directory([LAU, HEL]) });

		sockets[0]?.open();
		sockets[0]?.receive(frame("writeState", { mode: "readOnly" }));

		expect(client.setWriteMode).toHaveBeenLastCalledWith("readOnly");

		sockets[0]?.receive(drain);
		await settle();
		sockets[1]?.open();
		sockets[1]?.receive(frame("writeState", { mode: "normal" }));

		expect(client.setWriteMode).toHaveBeenLastCalledWith("readOnly");

		sockets[1]?.receive(frame("subscribed", { channels: [CHANNEL] }));

		expect(client.setWriteMode).toHaveBeenLastCalledWith("normal");
		expect(frames).toEqual([]);
	});

	it("passes every other frame on", async () => {
		await start({ nodes: null });

		sockets[0]?.open();

		const message = frame("messageEvent", { text: "hi" });

		sockets[0]?.receive(message);

		expect(frames).toEqual([message]);
		expect(sockets[0]?.closedWith).toBeNull();
	});
});
