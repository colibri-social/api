import { randomUUID } from "node:crypto";
import { type Database, resolvePrimaryUrl } from "@colibri-social/appview-db";
import { eq } from "drizzle-orm";
import pg from "pg";

export const BUS_CHANNEL = "colibri_events";

export const NOTIFY_LIMIT_BYTES = 7_900;

const RECONNECT_MS = 2_000;

export const REPLAY_WAIT_MS = 2_000;

export type BusDelivery<M> = {
	message: M;
	origin: string;
	lsn: string | null;
	local: boolean;
};

export type BusHandler<M> = (delivery: BusDelivery<M>) => void | Promise<void>;

export type EventBus<M> = {
	readonly nodeId: string;
	publish: (message: M) => void;
	subscribe: (handler: BusHandler<M>) => () => void;
	close: () => Promise<void>;
};

export type BusLog = {
	warn: (detail: Record<string, unknown>, event: string) => void;
	error: (detail: Record<string, unknown>, event: string) => void;
};

type Envelope = {
	o: string;
	l: string | null;
	m?: unknown;
	r?: string;
};

const dispatch = async <M>(
	handlers: ReadonlySet<BusHandler<M>>,
	delivery: BusDelivery<M>,
	log: BusLog,
): Promise<void> => {
	for (const handler of [...handlers]) {
		try {
			await handler(delivery);
		} catch (error) {
			log.error({ err: error }, "bus.handlerFailed");
		}
	}
};

export const memoryBus = <M>(nodeId: string, log: BusLog): EventBus<M> => {
	const handlers = new Set<BusHandler<M>>();
	let local: Promise<void> = Promise.resolve();

	return {
		nodeId,
		publish: (message) => {
			local = local.then(() =>
				dispatch(handlers, { message, origin: nodeId, lsn: null, local: true }, log),
			);
		},
		subscribe: (handler) => {
			handlers.add(handler);

			return () => handlers.delete(handler);
		},
		close: async () => {
			handlers.clear();
		},
	};
};

export type PostgresBusOptions = {
	url: string;
	nodeId: string;
	database: Database;
	log: BusLog;
};

export const postgresBus = async <M>({
	url,
	nodeId,
	database,
	log,
}: PostgresBusOptions): Promise<EventBus<M>> => {
	const handlers = new Set<BusHandler<M>>();
	let closed = false;
	let listener: pg.Client | null = null;
	let publisher: pg.Client | null = null;
	let queue: Promise<void> = Promise.resolve();
	let inbound: Promise<void> = Promise.resolve();
	let local: Promise<void> = Promise.resolve();

	const loadPayload = async (id: string): Promise<unknown> => {
		const { db, tables } = database;
		const [row] = await db
			.select({ payload: tables.eventPayloads.payload })
			.from(tables.eventPayloads)
			.where(eq(tables.eventPayloads.id, id))
			.limit(1);

		return row?.payload;
	};

	const receive = async (raw: string | undefined): Promise<void> => {
		if (!raw) {
			return;
		}

		const envelope = JSON.parse(raw) as Envelope;

		if (envelope.o === nodeId) {
			return;
		}

		if (envelope.r && envelope.l) {
			await database.waitForReplay(envelope.l, REPLAY_WAIT_MS);
		}

		const message = (envelope.r ? await loadPayload(envelope.r) : envelope.m) as M | undefined;

		if (message === undefined) {
			log.warn({ ref: envelope.r }, "bus.payloadMissing");

			return;
		}

		await dispatch(handlers, { message, origin: envelope.o, lsn: envelope.l, local: false }, log);
	};

	const target = async (): Promise<string> => {
		return (await database.primaryUrl()) ?? resolvePrimaryUrl(url);
	};

	const listen = async (): Promise<void> => {
		const client = new pg.Client({ connectionString: await target() });

		client.on("notification", (notification) => {
			if (notification.channel === BUS_CHANNEL) {
				inbound = inbound
					.then(() => receive(notification.payload))
					.catch((error: unknown) => {
						log.error({ err: error }, "bus.receiveFailed");
					});
			}
		});

		client.on("error", (error) => {
			log.error({ err: error }, "bus.listenerFailed");
			reconnect(client);
		});

		client.on("end", () => reconnect(client));

		await client.connect();
		await client.query(`listen ${BUS_CHANNEL}`);
		listener = client;
	};

	const reconnect = (client: pg.Client) => {
		if (closed || listener !== client) {
			return;
		}

		listener = null;

		const retry = () => {
			if (closed) {
				return;
			}

			void listen().catch((error: unknown) => {
				log.warn({ err: error }, "bus.reconnectFailed");
				setTimeout(retry, RECONNECT_MS).unref?.();
			});
		};

		setTimeout(retry, RECONNECT_MS).unref?.();
	};

	const publisherClient = async (): Promise<pg.Client> => {
		if (publisher) {
			return publisher;
		}

		const client = new pg.Client({ connectionString: await target() });

		client.on("error", (error) => {
			log.warn({ err: error }, "bus.publisherFailed");

			if (publisher === client) {
				publisher = null;
			}
		});

		await client.connect();
		publisher = client;

		return client;
	};

	const send = async (message: M): Promise<void> => {
		const client = await publisherClient();
		const inline = JSON.stringify(message);
		let ref: string | null = null;

		if (Buffer.byteLength(inline) > NOTIFY_LIMIT_BYTES) {
			ref = randomUUID();

			await database.db.insert(database.tables.eventPayloads).values({
				id: ref,
				payload: message as Record<string, unknown>,
				createdAt: new Date().toISOString(),
			});
		}

		const lsn = await client.query<{ lsn: string | null }>(
			"select case when pg_is_in_recovery() then null else pg_current_wal_lsn()::text end as lsn",
		);
		const position = lsn.rows[0]?.lsn ?? null;
		const envelope: Envelope = ref
			? { o: nodeId, l: position, r: ref }
			: { o: nodeId, l: position, m: message };

		await client.query("select pg_notify($1, $2)", [BUS_CHANNEL, JSON.stringify(envelope)]);
	};

	await listen();

	const stopFollowing = database.onPrimaryChange((primary) => {
		log.warn(
			{ host: new URL(primary.replace(/^postgres(ql)?:/, "http:")).hostname },
			"bus.primaryChanged",
		);

		const stalePublisher = publisher;

		publisher = null;
		void stalePublisher?.end().catch(() => {});

		const staleListener = listener;

		if (staleListener) {
			reconnect(staleListener);
			void staleListener.end().catch(() => {});
		}
	});

	return {
		nodeId,
		publish: (message) => {
			local = local.then(() =>
				dispatch(handlers, { message, origin: nodeId, lsn: null, local: true }, log),
			);

			queue = queue
				.then(() => send(message))
				.catch((error: unknown) => {
					log.error({ err: error }, "bus.publishFailed");
				});
		},
		subscribe: (handler) => {
			handlers.add(handler);

			return () => handlers.delete(handler);
		},
		close: async () => {
			closed = true;
			stopFollowing();
			handlers.clear();
			await queue;

			const clients = [listener, publisher];

			listener = null;
			publisher = null;

			await Promise.all(clients.map((client) => client?.end().catch(() => {})));
		},
	};
};
