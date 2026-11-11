import { access, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { NodeRole, NodeState, WriteMode } from "@colibri-social/appview-db";
import type { AppContext } from "../context.js";
import { resolveVersion } from "../routes/server.js";
import { createAnsibleRunner } from "./ansible.js";
import { type Cloudflare, createCloudflare, parseGeoRegions } from "./cloudflare.js";
import { ControlClient } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { runFailback } from "./failback.js";
import { askAlive, createFailoverWatch, FAILOVER_CHECK_MS, watchPrimary } from "./failover.js";
import { createFencing, FENCE_CHECK_MS } from "./fencing.js";
import { createHandover, type DeferState, shouldDefer } from "./handover.js";
import { resolveImage } from "./image-source.js";
import { connectKuma, createKumaSync } from "./kuma.js";
import { joinCluster, ownCredentials } from "./node-secret.js";
import { type ClusterOrder, handleOrder } from "./orders.js";
import { ALIVE_PATH, type Alive, aliveSchema, type DrainMode, type NodeFrame } from "./protocol.js";
import {
	databaseHostRuns,
	missingForProvisioning,
	needsPostgres,
	provisionVars,
} from "./provisioning.js";
import type { NodeAddress, NodeIdentity, NodeRow } from "./registry.js";
import { createRollout, type Rollout } from "./rollout.js";
import { WriteProxy } from "./write-proxy.js";

export const HEARTBEAT_MS = 15_000;

export const DEFAULT_REGION = "default";

export const POOL_SYNC_MS = 60_000;

export const HANDOVER_CHECK_MS = 30_000;

export const INVITE_MS = 60_000;

export const ALIVE_TIMEOUT_MS = 2_000;

export type ClusterNodeDeps = {
	ctx: AppContext;
	roles: ReadonlySet<NodeRole>;
	isMain: () => boolean;
	load: () => { connections: number; activeCalls: number };
	onDrain: (mode: DrainMode, graceMinutes: number | undefined) => void;
	onResume: () => void;
	onWriteMode: (mode: WriteMode) => void;
	yieldMain: (target: string) => Promise<boolean>;
	app: (request: IncomingMessage, response: ServerResponse) => void;
};

export type ClusterNode = {
	readonly parked: boolean;
	report: (frame: NodeFrame) => void;
	setState: (state: NodeState, drainDeadline?: Date | null) => Promise<void>;
	order: (order: ClusterOrder) => Promise<void>;
	becameMain: () => Promise<void>;
	mayTakeMain: () => Promise<boolean>;
	inviteToMain: (target: string) => void;
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

	const mainCapable = roles.has("main") || roles.has("failover");
	const joined = roles.has("main")
		? null
		: await joinCluster({
				file: config.NODE_SECRET_FILE,
				mainUrl: config.MAIN_NODE_URL,
				token: config.CLUSTER_JOIN_TOKEN,
				address,
			});

	const state = await registry.register(identity, address);
	const credentials = roles.has("main")
		? await ownCredentials({
				file: config.NODE_SECRET_FILE,
				id: identity.id,
				verify: registry.verify,
				issue: registry.issueSecret,
			})
		: joined;
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

	const primaryWatch =
		ctx.database.dialect === "postgres"
			? watchPrimary({ ping: () => ctx.database.ping(), log })
			: null;

	const control = ctx.clustered
		? new ControlServer({
				registry,
				log,
				nodeId: ctx.nodeId,
				isMain: deps.isMain,
				draining: () => ctx.drain.draining,
				primaryDownSince: () => primaryWatch?.downSince ?? null,
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

		if (main) {
			return main.id === ctx.nodeId ? null : main.tailnetUrl;
		}

		return config.MAIN_NODE_URL ?? null;
	};

	if (secret && roles.has("api")) {
		ctx.writeProxy = new WriteProxy({
			nodeId: ctx.nodeId,
			secret,
			windowMs: config.WRITE_QUEUE_SECONDS * 1_000,
			mainUrl,
			log,
			onMode: deps.onWriteMode,
			forwarding: () => !deps.isMain(),
		});
	}

	let invitedUntil = 0;
	const deferState: DeferState = { unclaimedSince: null };

	const mainNodesAlive = async (): Promise<(Alive | null)[]> => {
		const preferred = (await registry.list()).filter(
			(node) =>
				node.id !== ctx.nodeId &&
				node.roles.includes("main") &&
				node.state !== "retired" &&
				node.state !== "maintenance",
		);

		return Promise.all(
			preferred.map((node) =>
				fetch(new URL(ALIVE_PATH, node.tailnetUrl), {
					signal: AbortSignal.timeout(ALIVE_TIMEOUT_MS),
				})
					.then(async (response) => {
						const parsed = response.ok ? aliveSchema.safeParse(await response.json()) : null;

						return parsed?.success ? parsed.data : null;
					})
					.catch(() => null),
			),
		);
	};

	const mayTakeMain = async (): Promise<boolean> => {
		if (roles.has("main") || Date.now() < invitedUntil) {
			return true;
		}

		const answers = await mainNodesAlive().catch(() => []);

		return !shouldDefer(answers, deferState, Date.now());
	};

	const link = secret
		? new ControlClient({
				nodeId: ctx.nodeId,
				secret,
				log,
				mainUrl,
				onFrame: (frame) => {
					if (frame.t === "drain") deps.onDrain(frame.mode, frame.graceMinutes);
					if (frame.t === "resume") deps.onResume();
					if (frame.t === "takeMain") invitedUntil = Date.now() + INVITE_MS;
				},
			})
		: null;

	if (!secret && !roles.has("main")) {
		log.warn({ node: ctx.nodeId }, "cluster.unlinked.noSecret");
	}

	link?.start();

	const ansible =
		mainCapable &&
		(await access(config.SSH_KEY_FILE).then(
			() => true,
			() => false,
		))
			? createAnsibleRunner({
					directory: config.ANSIBLE_DIR,
					user: config.SSH_USER,
					keyFile: config.SSH_KEY_FILE,
					log,
				})
			: undefined;

	const cloudflare = mainCapable ? startCloudflare(ctx) : null;
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
					yieldMain: deps.yieldMain,
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

	const kuma =
		mainCapable && config.KUMA_URL && config.KUMA_USERNAME && config.KUMA_PASSWORD
			? connectKuma({
					url: config.KUMA_URL,
					username: config.KUMA_USERNAME,
					password: config.KUMA_PASSWORD,
					log,
				})
			: null;
	let remoteWriteUrl = config.PROMETHEUS_REMOTE_WRITE_URL ?? null;
	const statusHost = config.KUMA_PUBLIC_URL ? new URL(config.KUMA_PUBLIC_URL).hostname : null;
	const kumaSync = kuma
		? createKumaSync({
				api: kuma,
				slug: config.KUMA_STATUS_SLUG,
				title: "Colibri",
				statusHost,
				css: () => readFile(resolve(config.ANSIBLE_DIR, "../uptime-kuma/status.css"), "utf8"),
				apiUrl: config.PUBLIC_URL,
				log,
			})
		: null;

	const kumaTimer = kumaSync
		? setInterval(() => {
				if (!deps.isMain()) {
					return;
				}

				void registry
					.list()
					.then((nodes) => kumaSync.sync(nodes))
					.catch((error: unknown) => log.warn({ err: error }, "kuma.syncFailed"));
			}, POOL_SYNC_MS)
		: null;

	kumaTimer?.unref?.();

	const handover =
		roles.has("failover") && !roles.has("main")
			? createHandover({
					registry,
					self: ctx.nodeId,
					version: address.version,
					yieldMain: deps.yieldMain,
					busy: () => rollout?.running ?? false,
					log,
				})
			: null;

	const handoverTimer = handover
		? setInterval(() => {
				if (!deps.isMain() || ctx.drain.draining) {
					return;
				}

				void handover
					.tick()
					.catch((error: unknown) => log.warn({ err: error }, "main.handBackCheckFailed"));
			}, HANDOVER_CHECK_MS)
		: null;

	handoverTimer?.unref?.();

	const localUrl = config.LOCAL_POSTGRES_URL ?? config.DATABASE_READ_URL ?? null;
	const postgresUrl = ctx.database.dialect === "postgres" ? config.DATABASE_URL : null;
	const ownTailnetHost = new URL(address.tailnetUrl).hostname;

	const rejoin = ansible
		? async (node: NodeRow | null, primaryHosts: string[]) => {
				const self = node === null;
				const host = self ? ownTailnetHost : new URL(node.tailnetUrl).hostname;
				const result = await ansible.run({
					playbook: "rejoin-replica",
					host,
					vars: {
						primary_hosts: primaryHosts.join(","),
						stack_dir: self ? config.STACK_DIR : "/opt/colibri",
						detach: self,
					},
				});

				if (!result.ok) {
					log.error(
						{ node: node?.id ?? ctx.nodeId, tail: result.tail.slice(-10) },
						"failover.rejoinFailed",
					);
				}

				return result.ok;
			}
		: undefined;

	const failoverWatch =
		roles.has("failover") && localUrl && postgresUrl
			? createFailoverWatch({
					nodeId: ctx.nodeId,
					localUrl,
					databaseUrl: postgresUrl,
					afterMs: config.FAILOVER_AFTER_SECONDS * 1_000,
					primary: () => primaryWatch?.downSince ?? null,
					nodes: () => registry.list(),
					ask: (node) => askAlive(node),
					onPromoted: () => log.warn({ node: ctx.nodeId }, "failover.nowPrimary"),
					log,
				})
			: null;

	void failoverWatch?.refresh();

	const failoverTimer = failoverWatch
		? setInterval(() => void failoverWatch.tick(), FAILOVER_CHECK_MS)
		: null;

	failoverTimer?.unref?.();

	const fencing =
		mainCapable && localUrl && postgresUrl
			? createFencing({
					nodeId: ctx.nodeId,
					localUrl,
					databaseUrl: postgresUrl,
					ownTailnetHost,
					isMain: deps.isMain,
					nodes: () => registry.list(),
					...(rejoin ? { rejoin } : {}),
					log,
				})
			: null;

	const fencingTimer = fencing
		? setInterval(() => {
				void fencing
					.tick()
					.catch((error: unknown) => log.warn({ err: error }, "failover.fenceCheckFailed"));
			}, FENCE_CHECK_MS)
		: null;

	fencingTimer?.unref?.();

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
					...(postgresUrl
						? {
								failback: (target: string | undefined) =>
									runFailback(
										{
											self: ctx.nodeId,
											localUrl,
											databaseUrl: postgresUrl,
											nodes: () => registry.list(),
											yieldMain: deps.yieldMain,
											log,
										},
										target,
									),
							}
						: {}),
					...(cloudflare
						? {
								dns: {
									put: (node, host, ip) => cloudflare.putNodeRecord(node, host, ip),
									remove: (host) => cloudflare.removeNodeRecord(host),
									alias: (host, target) => cloudflare.putAlias(host, target),
								},
							}
						: {}),
					provisioning: {
						missing: (nodeRoles) => missingForProvisioning(config, nodeRoles),
						vars: async (target) =>
							provisionVars(
								config,
								{
									tailnetUrl: address.tailnetUrl,
									standbyHosts: (await registry.list())
										.filter(
											(node) =>
												node.id !== target.node &&
												node.id !== ctx.nodeId &&
												node.state !== "retired" &&
												(node.roles.includes("main") || node.roles.includes("failover")),
										)
										.map((node) => new URL(node.tailnetUrl).hostname),
								},
								target,
							),
						removeNode: (id) => registry.remove(id),
						spreadDatabaseHosts: async () => {
							if (!ansible) return;

							const nodes = (await registry.list()).filter((node) => node.state !== "retired");

							for (const run of databaseHostRuns(config, nodes, ctx.nodeId)) {
								const result = await ansible.run({
									playbook: "database-hosts",
									host: run.host,
									vars: run.vars,
								});

								if (!result.ok) log.warn({ node: run.node }, "failover.databaseHostsFailed");
							}
						},
					},
					monitoring: {
						vars: () =>
							config.GRAFANA_ADMIN_PASSWORD
								? {
										grafana_admin_password: config.GRAFANA_ADMIN_PASSWORD,
										alert_webhook_url: config.ALERT_WEBHOOK_URL ?? "",
										grafana_image: config.GRAFANA_IMAGE,
										prometheus_image: config.PROMETHEUS_IMAGE,
										stack_dir: config.STACK_DIR,
									}
								: null,
						remoteWriteUrl: () => remoteWriteUrl,
						setRemoteWriteUrl: async (url) => {
							await ctx.clusterConfig.set("PROMETHEUS_REMOTE_WRITE_URL", url);
							remoteWriteUrl = url;
						},
						alloyVars: (node, self, url) => ({
							remote_write_url: url,
							alloy_image: config.ALLOY_IMAGE,
							postgres: self || needsPostgres(node.roles),
							probes: self,
							stack_dir: self ? config.STACK_DIR : "/opt/colibri",
						}),
					},
					status: {
						host: statusHost,
						vars: (node) =>
							statusHost
								? {
										kuma_image: config.KUMA_IMAGE,
										status_host: statusHost,
										stack_dir: node.self ? config.STACK_DIR : "/opt/colibri",
									}
								: null,
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
		becameMain: async () => {
			invitedUntil = 0;
			await registry.claimMain(ctx.nodeId);
		},
		mayTakeMain,
		inviteToMain: (target) => {
			control?.send(target, { t: "takeMain" });
		},
		stop: async () => {
			clearInterval(heartbeat);
			primaryWatch?.stop();
			if (failoverTimer) clearInterval(failoverTimer);
			if (fencingTimer) clearInterval(fencingTimer);
			if (rolloutTimer) clearInterval(rolloutTimer);
			if (poolTimer) clearInterval(poolTimer);
			if (kumaTimer) clearInterval(kumaTimer);
			if (handoverTimer) clearInterval(handoverTimer);
			kuma?.close();
			ctx.writeProxy?.stop();
			link?.stop();
			await control?.close();
		},
	};
};
