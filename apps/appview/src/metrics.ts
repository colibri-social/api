import type { DeliveryOutcome, PushSender, Senders } from "@colibri-social/notifications";
import {
	type Attributes,
	type Counter,
	type Histogram,
	type Meter,
	metrics as otelMetrics,
} from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

export type Sample = {
	value: number;
	attributes?: Attributes;
};

export type GaugeName =
	| "buildInfo"
	| "connections"
	| "jetstreamLag"
	| "syncQueue"
	| "drainState"
	| "writeMode"
	| "writeQueue"
	| "voiceCalls"
	| "voiceParticipants"
	| "sfuWorkerCpu"
	| "sfuBitrate"
	| "sfuPacketLoss"
	| "sfuTransports";

export type CounterName = "pushDeliveries" | "turnCredentials" | "jetstreamEvents" | "syncFailures";

export type HistogramName = "xrpcDuration" | "syncLag" | "voiceJoinDuration";

export type MetricsHandle = {
	stop: () => Promise<void>;
};

type PushProvider = keyof Senders;

type PushOutcome = Exclude<DeliveryOutcome, "not-configured">;

type PushType = Parameters<PushSender["send"]>[1]["type"];

type Instruments = {
	counters: Record<CounterName, Counter>;
	histograms: Record<HistogramName, Histogram>;
};

const GAUGES: Record<GaugeName, { name: string; description: string }> = {
	buildInfo: {
		name: "colibri_build_info",
		description: "Always 1, labelled with the AppView version this node runs",
	},
	connections: {
		name: "colibri_connections",
		description: "Open client sockets on this node, by kind",
	},
	jetstreamLag: {
		name: "colibri_jetstream_lag_seconds",
		description: "Age of the last Jetstream event the node processed",
	},
	syncQueue: { name: "colibri_sync_queue", description: "Space repos waiting to sync, by state" },
	drainState: {
		name: "colibri_drain_state",
		description: "0 when serving, 1 while draining, 2 when parked",
	},
	writeMode: {
		name: "colibri_write_mode",
		description: "0 when writes reach the main node, 1 while queued, 2 when read-only",
	},
	writeQueue: { name: "colibri_write_queue", description: "Writes waiting for the main node" },
	voiceCalls: { name: "colibri_voice_calls", description: "Calls running on this node" },
	voiceParticipants: {
		name: "colibri_voice_participants",
		description: "Call participants on this node",
	},
	sfuWorkerCpu: {
		name: "colibri_sfu_worker_cpu_seconds",
		description: "CPU time used by each SFU worker",
	},
	sfuBitrate: {
		name: "colibri_sfu_bitrate_bits_per_second",
		description: "Media bitrate through the SFU, by direction",
	},
	sfuPacketLoss: {
		name: "colibri_sfu_packet_loss",
		description: "Highest RTP packet loss ratio across transports, by direction",
	},
	sfuTransports: {
		name: "colibri_sfu_transports",
		description: "WebRTC transports, by ICE state",
	},
};

const COUNTERS: Record<CounterName, { name: string; description: string }> = {
	pushDeliveries: {
		name: "colibri_push_deliveries",
		description: "Push sends per device, by provider, outcome and type",
	},
	turnCredentials: {
		name: "colibri_turn_credentials",
		description: "TURN credential requests, by outcome",
	},
	jetstreamEvents: { name: "colibri_jetstream_events", description: "Jetstream events processed" },
	syncFailures: { name: "colibri_sync_failures", description: "Space repo syncs that failed" },
};

const HISTOGRAMS: Record<
	HistogramName,
	{ name: string; description: string; boundaries: number[] }
> = {
	xrpcDuration: {
		name: "colibri_xrpc_duration_seconds",
		description: "XRPC request duration, by method and status",
		boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	},
	syncLag: {
		name: "colibri_sync_lag_seconds",
		description: "Time from a repo change notice to its commit in the AppView",
		boundaries: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
	},
	voiceJoinDuration: {
		name: "colibri_voice_join_duration_seconds",
		description: "Time to join a call on the SFU",
		boundaries: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	},
};

const PUSH_PROVIDERS = {
	webpush: true,
	fcm: true,
	apns: true,
} satisfies Record<PushProvider, true>;

const PUSH_OUTCOMES = {
	delivered: true,
	gone: true,
	failed: true,
} satisfies Record<PushOutcome, true>;

const PUSH_TYPES = {
	message: true,
	edit: true,
	delete: true,
	read: true,
} satisfies Record<PushType, true>;

const sources = new Map<GaugeName, () => Sample[] | Promise<Sample[]>>();
let constants: Attributes = {};

const createInstruments = (meter: Meter): Instruments => {
	const counters = Object.fromEntries(
		Object.entries(COUNTERS).map(([key, spec]) => [
			key,
			meter.createCounter(spec.name, { description: spec.description }),
		]),
	) as Record<CounterName, Counter>;
	const histograms = Object.fromEntries(
		Object.entries(HISTOGRAMS).map(([key, spec]) => [
			key,
			meter.createHistogram(spec.name, {
				description: spec.description,
				advice: { explicitBucketBoundaries: spec.boundaries },
			}),
		]),
	) as Record<HistogramName, Histogram>;

	for (const [key, spec] of Object.entries(GAUGES) as [GaugeName, (typeof GAUGES)[GaugeName]][]) {
		meter
			.createObservableGauge(spec.name, { description: spec.description })
			.addCallback(async (result) => {
				const source = sources.get(key);

				if (!source) {
					return;
				}

				for (const sample of await Promise.resolve(source()).catch(() => [])) {
					result.observe(sample.value, { ...constants, ...sample.attributes });
				}
			});
	}

	return { counters, histograms };
};

let current: Instruments = createInstruments(otelMetrics.getMeterProvider().getMeter("noop"));

export const observe = (
	name: GaugeName,
	source: () => Sample[] | Promise<Sample[]>,
): (() => void) => {
	sources.set(name, source);

	return () => {
		if (sources.get(name) === source) sources.delete(name);
	};
};

export const count = (name: CounterName, attributes: Attributes = {}, by = 1): void => {
	current.counters[name].add(by, { ...constants, ...attributes });
};

export const record = (name: HistogramName, value: number, attributes: Attributes = {}): void => {
	current.histograms[name].record(value, { ...constants, ...attributes });
};

const zeroPushDeliveries = (): void => {
	for (const provider of Object.keys(PUSH_PROVIDERS)) {
		for (const outcome of Object.keys(PUSH_OUTCOMES)) {
			for (const type of Object.keys(PUSH_TYPES)) {
				count("pushDeliveries", { provider, outcome, type }, 0);
			}
		}
	}
};

export const xrpcMethod = (path: string): string | null => {
	if (!path.startsWith("/xrpc/")) {
		return null;
	}

	const method = path.slice("/xrpc/".length).split("?")[0] ?? "";

	return /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){2,}$/.test(method) ? method : "other";
};

export const startMetrics = (options: {
	host: string;
	port: number;
	attributes: Attributes;
}): MetricsHandle => {
	const exporter = new PrometheusExporter({
		host: options.host,
		port: options.port,
		withoutScopeInfo: true,
		withoutTargetInfo: true,
	});
	const provider = new MeterProvider({ readers: [exporter] });

	constants = options.attributes;
	current = createInstruments(provider.getMeter("colibri-appview"));

	zeroPushDeliveries();

	return {
		stop: async () => {
			await provider.shutdown().catch(() => undefined);
		},
	};
};
