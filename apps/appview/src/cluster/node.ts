import { hostname } from "node:os";
import type { NodeRole, NodeState } from "@colibri-social/appview-db";
import type { AppContext } from "../context.js";
import { resolveVersion } from "../routes/server.js";
import { ControlClient } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { joinCluster } from "./node-secret.js";
import { type ClusterOrder, handleOrder } from "./orders.js";
import type { NodeFrame, ParkMode } from "./protocol.js";
import type { NodeAddress, NodeIdentity } from "./registry.js";

export const HEARTBEAT_MS = 15_000;

export const DEFAULT_REGION = "default";

export type ClusterNodeDeps = {
	ctx: AppContext;
	roles: ReadonlySet<NodeRole>;
	isMain: () => boolean;
	load: () => { connections: number; activeCalls: number };
	onDrain: (mode: ParkMode, graceMinutes: number | undefined) => void;
	onResume: () => void;
};

export type ClusterNode = {
	readonly parked: boolean;
	report: (frame: NodeFrame) => void;
	setState: (state: NodeState, drainDeadline?: Date | null) => Promise<void>;
	order: (order: ClusterOrder) => Promise<void>;
	becameMain: () => Promise<void>;
	stop: () => Promise<void>;
};

export const nodeAddress = (ctx: AppContext): NodeAddress => {
	const { config } = ctx;

	return {
		publicUrl: config.NODE_PUBLIC_URL ?? config.PUBLIC_URL,
		tailnetUrl:
			config.NODE_TAILNET_URL ?? `http://${hostname()}:${config.CLUSTER_PORT}`,
		...(config.SFU_ANNOUNCED_IP
			? { announcedIp: config.SFU_ANNOUNCED_IP }
			: {}),
		version: resolveVersion(),
	};
};

export const startClusterNode = async (
	deps: ClusterNodeDeps,
): Promise<ClusterNode | null> => {
	const { ctx, roles } = deps;
	const { config, registry, log } = ctx;

	if (!ctx.clustered) {
		return null;
	}

	const identity: NodeIdentity = {
		id: ctx.nodeId,
		region: config.NODE_REGION ?? DEFAULT_REGION,
		roles: [...roles],
	};

	const address = nodeAddress(ctx);

	const secret = roles.has("main")
		? null
		: await joinCluster({
				file: config.NODE_SECRET_FILE,
				mainUrl: config.MAIN_NODE_URL,
				token: config.CLUSTER_JOIN_TOKEN,
				address,
			});

	const state = await registry.register(identity, address);
	const parked = state === "maintenance" || state === "retired";

	log.info(
		{ node: identity.id, region: identity.region, state },
		"cluster.registered",
	);

	const control =
		roles.has("main") || roles.has("failover")
			? new ControlServer({
					registry,
					log,
					nodeId: ctx.nodeId,
					isMain: deps.isMain,
					onFrame: (nodeId, frame) =>
						log.info({ node: nodeId, mode: frame.mode }, "cluster.drained"),
				})
			: null;

	if (control) {
		const port = await control.listen(config.CLUSTER_PORT, config.HOST);

		log.info({ port }, "cluster.listening");
	}

	const link = secret
		? new ControlClient({
				nodeId: ctx.nodeId,
				secret,
				log,
				mainUrl: async () => {
					const main = await registry.mainNode();

					return main && main.id !== ctx.nodeId
						? main.tailnetUrl
						: (config.MAIN_NODE_URL ?? null);
				},
				onFrame: (frame) => {
					if (frame.t === "drain") deps.onDrain(frame.mode, frame.graceMinutes);
					if (frame.t === "resume") deps.onResume();
				},
			})
		: null;

	if (!secret && !roles.has("main")) {
		log.warn({ node: ctx.nodeId }, "cluster.unlinked.noSecret");
	}

	link?.start();

	const heartbeat = setInterval(() => {
		void registry
			.heartbeat(ctx.nodeId, { ...deps.load(), version: address.version })
			.catch((error: unknown) =>
				log.warn({ err: error }, "cluster.heartbeatFailed"),
			);
	}, HEARTBEAT_MS);

	heartbeat.unref?.();

	return {
		parked,
		report: (frame) => {
			link?.send(frame);
		},
		setState: (next, drainDeadline) =>
			registry.setState(ctx.nodeId, next, drainDeadline),
		order: async (order) => {
			if (!deps.isMain()) {
				return;
			}

			const result = await handleOrder(
				{
					registry,
					self: ctx.nodeId,
					send: (nodeId, frame) => control?.send(nodeId, frame) ?? false,
				},
				order,
			);

			log.info(
				{ ...result, kind: order.kind, node: order.node },
				"cluster.order",
			);
			ctx.announce.clusterOrderResult(result);
		},
		becameMain: () => registry.claimMain(ctx.nodeId),
		stop: async () => {
			clearInterval(heartbeat);
			link?.stop();
			await control?.close();
		},
	};
};
