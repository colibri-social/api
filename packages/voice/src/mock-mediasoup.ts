import { EventEmitter } from "node:events";
import type {
	AudioLevelObserver,
	Consumer,
	MediaKind,
	Producer,
	Router,
	RtpCapabilities,
	WebRtcTransport,
	Worker,
} from "mediasoup/types";
import { vi } from "vitest";

let nextId = 0;

function id(prefix: string): string {
	nextId += 1;
	return `${prefix}-${nextId}`;
}

export function createFakeProducer(kind: MediaKind) {
	const emitter = new EventEmitter();
	let paused = false;
	const producer = Object.assign(emitter, {
		id: id("producer"),
		kind,
		pause: vi.fn(async () => {
			paused = true;
		}),
		resume: vi.fn(async () => {
			paused = false;
		}),
		close: vi.fn(),
	});
	Object.defineProperty(producer, "paused", { get: () => paused, enumerable: true });
	return producer as typeof producer & { paused: boolean };
}

export function createFakeConsumer(producerId: string, kind: MediaKind) {
	const emitter = new EventEmitter();
	let paused = true;
	const consumer = Object.assign(emitter, {
		id: id("consumer"),
		producerId,
		kind,
		pause: vi.fn(async () => {
			paused = true;
		}),
		resume: vi.fn(async () => {
			paused = false;
		}),
		close: vi.fn(),
	});
	Object.defineProperty(consumer, "paused", { get: () => paused, enumerable: true });
	return consumer as typeof consumer & { paused: boolean };
}

export function createFakeAudioLevelObserver() {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		id: id("audio-level-observer"),
		addProducer: vi.fn(async () => {}),
		removeProducer: vi.fn(async () => {}),
		close: vi.fn(),
	});
}

export function createFakeTransport() {
	const emitter = new EventEmitter();
	const producers = new Map<string, ReturnType<typeof createFakeProducer>>();

	const transport = Object.assign(emitter, {
		id: id("transport"),
		connect: vi.fn(async () => {}),
		close: vi.fn(() => {
			for (const producer of producers.values()) producer.emit("transportclose");
			emitter.emit("transportclose");
		}),
		produce: vi.fn(async (options: { kind: MediaKind; paused?: boolean }) => {
			const producer = createFakeProducer(options.kind);
			if (options.paused) {
				await producer.pause();
			}
			producers.set(producer.id, producer);
			return producer;
		}),
		consume: vi.fn(async (options: { producerId: string; kind?: MediaKind }) => {
			const producer = producers.get(options.producerId);
			return createFakeConsumer(options.producerId, producer?.kind ?? "audio");
		}),
	});

	return transport;
}

export function createFakeRouter(rtpCapabilities: RtpCapabilities = {}) {
	const audioLevelObserver = createFakeAudioLevelObserver();
	const emitter = new EventEmitter();
	let closed = false;

	const router = Object.assign(emitter, {
		id: id("router"),
		rtpCapabilities,
		close: vi.fn(() => {
			closed = true;
		}),
		createWebRtcTransport: vi.fn(async () => createFakeTransport()),
		createAudioLevelObserver: vi.fn(async () => audioLevelObserver),
		audioLevelObserver,
		killWorker: () => {
			closed = true;
			emitter.emit("workerclose");
		},
	});
	Object.defineProperty(router, "closed", { get: () => closed, enumerable: true });
	return router as typeof router & { closed: boolean };
}

export function createFakeWorker(pid: number, options: { autoExit?: boolean } = {}) {
	const emitter = new EventEmitter();
	const autoExit = options.autoExit ?? true;
	let closed = false;
	let subprocessClosed = false;

	const exitSubprocess = () => {
		if (subprocessClosed) return;
		subprocessClosed = true;
		emitter.emit("subprocessclose");
	};

	const worker = Object.assign(emitter, {
		pid,
		close: vi.fn(() => {
			if (closed) return;
			closed = true;
			if (autoExit) exitSubprocess();
		}),
		exitSubprocess,
		createRouter: vi.fn(async () => createFakeRouter()),
	});

	Object.defineProperty(worker, "closed", { get: () => closed, enumerable: true });
	Object.defineProperty(worker, "subprocessClosed", {
		get: () => subprocessClosed,
		enumerable: true,
	});

	return worker as typeof worker & { closed: boolean; subprocessClosed: boolean };
}

export function asRouter(router: ReturnType<typeof createFakeRouter>): Router {
	return router as unknown as Router;
}

export function asWorker(worker: ReturnType<typeof createFakeWorker>): Worker {
	return worker as unknown as Worker;
}

export function asAudioLevelObserver(
	observer: ReturnType<typeof createFakeAudioLevelObserver>,
): AudioLevelObserver {
	return observer as unknown as AudioLevelObserver;
}

export function asTransport(transport: ReturnType<typeof createFakeTransport>): WebRtcTransport {
	return transport as unknown as WebRtcTransport;
}

export function asProducer(producer: ReturnType<typeof createFakeProducer>): Producer {
	return producer as unknown as Producer;
}

export function asConsumer(consumer: ReturnType<typeof createFakeConsumer>): Consumer {
	return consumer as unknown as Consumer;
}
