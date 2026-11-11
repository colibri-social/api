import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { NodeRole, NodeState, WriteMode } from "@colibri-social/appview-db";
import type { AppContext } from "../context.js";
import { resolveVersion } from "../routes/server.js";
import { createAnsibleRunner } from "./ansible.js";
import { type Cloudflare, createCloudflare, parseGeoRegions } from "./cloudflare.js";
import { ControlClient } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { resolveImage } from "./image-source.js";
import { joinCluster } from "./node-secret.js";
import { type ClusterOrder, handleOrder } from "./orders.js";
import type { DrainMode, NodeFrame } from "./protocol.js";
import { missingForProvisioning, provisionVars } from "./provisioning.js";
import type { NodeAddress, NodeIdentity } from "./registry.js";
import { createRollout, type Rollout } from "./rollout.js";
import { WriteProxy } from "./write-proxy.js";

export const HEARTBEAT_MS = 15_000;

export const DEFAULT_REGION = "default";

export const POOL_SYNC_MS = 60_000;

export type ClusterNodeDeps = {
	ctx: AppContext;
	roles: ReadonlySet<NodeRole>;
	isMain: () => boolean;
	load: () => { connections: number; activeCalls: number };
	onDrain: (mode: DrainMode, graceMinutes: number | undefined) => void;
	onResume: () => void;
	onWriteMode: (mode: WriteMode) => void;
	app: (request: IncomingMessage, response: ServerResponse) => void;
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
		tailnetUrl: config.NODE_TAILNET_URL ?? `http://${hostname()}:${config.CLUSTER_PORT}`,
		...(config.SFU_ANNOUNCED_IP ? { announcedIp: config.SFU_ANNOUNCED_IP } : {}),
		version: resolveVersion(),
	};
};

const startCloudflare = (ctx: AppContext): Cloudflare | null => {
	const { config, log } = ctx;

	if (!config.CLOUDFLARE_API_TOKEN || !config.CLOUDFLARE_ZONE_ID) {
		return null;
	}

	try {
		return createCloudflare({
			token: config.CLOUDFLARE_API_TOKEN,
			accountId: config.CLOUDFLARE_ACCOUNT_ID,
			zoneId: config.CLOUDFLARE_ZONE_ID,
			loadBalancerId: config.CLOUDFLARE_LB_ID,
			geo: parseGeoRegions(config.CLOUDFLARE_GEO_REGIONS),
			mainRegion: config.NODE_REGION ?? DEFAULT_REGION,
			log,
		});
	} catch (error) {
		log.error({ err: error }, "cloudflare.misconfigured");

		return null;
	}
};

export const startClusterNode = async (deps: ClusterNodeDeps): Promise<ClusterNode | null> => {
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

	const credentials = roles.has("main")
		? null
		: await joinCluster({
				file: config.NODE_SECRET_FILE,
				mainUrl: config.MAIN_NODE_URL,
				token: config.CLUSTER_JOIN_TOKEN,
				address,
			});

	const state = await registry.register(identity, address);
	const parked = state === "maintenance" || state === "retired";

	log.info({ node: identity.id, region: identity.region, state }, "cluster.registered");

	const drainWaiters = new Map<string, Set<() => void>>();

	const drained = (nodeId: string, timeoutMs: number): Promise<boolean> => {
		return new Promise((settle) => {
			const waiters = drainWaiters.get(nodeId) ?? new Set<() => void>();
			const finish = (outcome: boolean) => {
				clearTimeout(timer);
				waiters.delete(done);
				settle(outcome);
			};
			const done = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);

			waiters.add(done);
			drainWaiters.set(nodeId, waiters);
		});
	};

	const control =
		roles.has("main") || roles.has("failover")
			? new ControlServer({
					registry,
					log,
					nodeId: ctx.nodeId,
					isMain: deps.isMain,
					config: () => ctx.clusterConfig.values(),
					app: deps.app,
					onFrame: (nodeId, frame) => {
						log.info({ node: nodeId, mode: frame.mode }, "cluster.drained");

						if (frame.mode === "update") {
							for (const done of [...(drainWaiters.get(nodeId) ?? [])]) done();
						}
					},
				})
			: null;

	if (control) {
		const port = await control.listen(config.CLUSTER_PORT, config.HOST);

		log.info({ port }, "cluster.listening");
	}

	const secret = credentials?.secret ?? null;
	const mainUrl = async (): Promise<string | null> => {
		const main = await registry.mainNode().catch(() => null);

		return main && main.id !== ctx.nodeId ? main.tailnetUrl : (config.MAIN_NODE_URL ?? null);
	};

	if (secret && roles.has("api")) {
		ctx.writeProxy = new WriteProxy({
			nodeId: ctx.nodeId,
			secret,
			windowMs: config.WRITE_QUEUE_SECONDS * 1_000,
			mainUrl,
			log,
			onMode: deps.onWriteMode,
		});
	}

	const link = secret
		? new ControlClient({
				nodeId: ctx.nodeId,
				secret,
				log,
				mainUrl,
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

	const ansible = roles.has("main")
		? createAnsibleRunner({
				directory: config.ANSIBLE_DIR,
				user: config.SSH_USER,
				keyFile: config.SSH_KEY_FILE,
				log,
			})
		: undefined;

	const cloudflare = roles.has("main") ? startCloudflare(ctx) : null;
	const send = (nodeId: string, frame: Parameters<ControlServer["send"]>[1]) => {
		return control?.send(nodeId, frame) ?? false;
	};

	const rollout: Rollout | null =
		ansible && config.UPDATE_POLL_MINUTES > 0
			? createRollout({
					registry,
					self: ctx.nodeId,
					image: config.NODE_IMAGE,
					stackDir: config.STACK_DIR,
					drainMinutes: config.DRAIN_GRACE_MINUTES,
					resolve: (image) =>
						resolveImage(image, {
							credentials: config.REGISTRY_TOKEN
								? { user: config.REGISTRY_USER ?? "colibri", token: config.REGISTRY_TOKEN }
								: undefined,
						}),
					ansible,
					send,
					drained,
					active: () => deps.isMain() && !ctx.drain.draining,
					log,
				})
			: null;

	const rolloutTimer = rollout
		? setInterval(() => {
				void rollout
					.tick()
					.catch((error: unknown) => log.error({ err: error }, "rollout.tickFailed"));
			}, config.UPDATE_POLL_MINUTES * 60_000)
		: null;

	rolloutTimer?.unref?.();

	const poolTimer = cloudflare?.managesPools
		? setInterval(() => {
				if (!deps.isMain()) {
					return;
				}

				void registry
					.list()
					.then((nodes) => cloudflare.syncPools(nodes))
					.catch((error: unknown) => log.warn({ err: error }, "cloudflare.syncFailed"));
			}, POOL_SYNC_MS)
		: null;

	poolTimer?.unref?.();

	const heartbeat = setInterval(() => {
		void registry
			.heartbeat(ctx.nodeId, { ...deps.load(), version: address.version })
			.catch((error: unknown) => log.warn({ err: error }, "cluster.heartbeatFailed"));
	}, HEARTBEAT_MS);

	heartbeat.unref?.();

	return {
		parked,
		report: (frame) => {
			link?.send(frame);
		},
		setState: (next, drainDeadline) => registry.setState(ctx.nodeId, next, drainDeadline),
		order: async (order) => {
			if (!deps.isMain()) {
				return;
			}

			const result = await handleOrder(
				{
					registry,
					self: ctx.nodeId,
					send,
					...(ansible ? { ansible } : {}),
					...(cloudflare
						? {
								dns: {
									put: (node, host, ip) => cloudflare.putNodeRecord(node, host, ip),
									remove: (host) => cloudflare.removeNodeRecord(host),
								},
							}
						: {}),
					provisioning: {
						missing: (nodeRoles) => missingForProvisioning(config, nodeRoles),
						vars: async (target) =>
							provisionVars(config, { tailnetUrl: address.tailnetUrl }, target),
						removeNode: (id) => registry.remove(id),
					},
					background: (work) => {
						void work.catch((error: unknown) => log.warn({ err: error }, "ansible.runFailed"));
					},
				},
				order,
			);

			log.info({ ...result, kind: order.kind, node: order.node }, "cluster.order");
			ctx.announce.clusterOrderResult(result);
		},
		becameMain: () => registry.claimMain(ctx.nodeId),
		stop: async () => {
			clearInterval(heartbeat);
			if (rolloutTimer) clearInterval(rolloutTimer);
			if (poolTimer) clearInterval(poolTimer);
			ctx.writeProxy?.stop();
			link?.stop();
			await control?.close();
		},
	};
};
