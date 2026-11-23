import {
	type AttachmentInput,
	type BlobRef,
	type ColibriClient,
	ColibriRequestError,
	type ForwardInput,
	type ImportedMessageInput,
	type ListMessagesOptions,
	type MessageView,
	type RegistrationRef,
	type RegistrationView,
	type ThreadView,
} from "./client.js";
import {
	type BridgeConnection,
	type BridgeContext,
	type BridgeLogger,
	type Connector,
	canDelete,
	canEdit,
	canImportHistory,
	canModerate,
	canOpen,
	canOpenDelete,
	canOpenEdit,
	canOpenLifecycle,
	canOpenModerate,
	canOpenReact,
	canOpenThread,
	canReact,
	canRelay,
	canThread,
	type DroppedAttachment,
	type HistoryConnector,
	type HistoryMessage,
	type HistoryThread,
	type InboundEvent,
	type LinkedRoom,
	type MemberStanding,
	type MessageRef,
	type OpenChannelContent,
	type OpenChannelForwardInput,
	type OpenChannelInfo,
	type OpenChannelMessage,
	type OpenChannelRef,
	type OpenChannelsChange,
	type OpenEmitResult,
	type OpenHistoryRequest,
	type OpenInboundEvent,
	type OutboundForward,
	type RemoteAttachment,
	type RemoteAuthor,
	type RemoteLocation,
	type RemoteThread,
} from "./connector.js";
import { EventStream, type EventStreamOptions, frameKind, type ServerFrame } from "./events.js";
import { BoundedSet, ExpiringCache, outboundAttachments, outboundEmbeds } from "./open.js";
import type { BackfillProgress, BridgeStore } from "./store.js";
import {
	colibriToMarkdown,
	type Feature,
	markdownToColibri,
	parseTimeReferenceId,
	type RemoteReference,
	TIME_STYLES,
	timeReferenceId,
} from "./text.js";

export type BridgeOptions = {
	client: ColibriClient;
	connector: Connector;
	store: BridgeStore;
	log?: BridgeLogger;
	maxAttachmentBytes?: number;
	maxRetries?: number;
	createEventStream?: (
		options: EventStreamOptions,
	) => Pick<EventStream, "start" | "stop" | "setChannels">;
	sleep?: (ms: number) => Promise<void>;
	backfillBatchSize?: number;
	backfillReportIntervalMs?: number;
};

type OpenChannel = RegistrationRef & { mirrorModeration: boolean };

type OpenTarget = OpenChannel & { channel: string; thread?: string };

type OpenSnapshot = Map<string, RegistrationRef & { channels: string[] }>;

type AttachmentResult = { attachments: AttachmentInput[]; dropped: DroppedAttachment[] };

type MemberRef = RegistrationRef & { did: string; channel: string };

type Portal = LinkedRoom & {
	key: string;
	remoteSpace: string;
	platform: string;
	mirrorModeration: boolean;
	links: RegistrationView["links"];
	parentChannel: string;
	remoteThread?: string;
	backfill?: { since?: string; requestedAt: string };
};

type BackfillJob = {
	connector: HistoryConnector;
	parent: Portal;
	key: string;
	since?: string;
	until: string;
	progress: BackfillProgress;
	reportedAt: number;
};

type InboundMessage = Pick<
	HistoryMessage,
	"id" | "author" | "markdown" | "replyTo" | "attachments" | "forward"
>;

type PreparedMessage = Omit<ImportedMessageInput, "remoteMessage" | "createdAt">;

type ColibriRecordKey = { channel: string; did: string; rkey: string };

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_BACKFILL_BATCH_SIZE = 25;
const DEFAULT_BACKFILL_REPORT_INTERVAL_MS = 5000;
const BACKFILL_RETRIES = 8;
const INVALID_HANDLE = "handle.invalid";
const MAX_THREAD_NAME = 128;
const ECHO_CAPACITY = 1000;
const MEMBER_CACHE_CAPACITY = 1000;
const MEMBER_CACHE_TTL_MS = 60_000;
const OPEN_HISTORY_LIMIT = 50;
const MAX_OPEN_HISTORY_LIMIT = 100;
const OPEN_MESSAGE_WINDOW = 9;
const FALLBACK_THREAD_NAME = "Thread";
const CHANNEL_FEATURE = "social.colibri.beta.richtext.facet#channel";
const BRIDGED_MENTION_FEATURE = "social.colibri.beta.richtext.facet#bridgedMention";
const TIME_FEATURE = "social.colibri.beta.richtext.facet#time";

const timeFeature = (id: string): Feature | null => {
	const reference = parseTimeReferenceId(id);
	const date = reference ? new Date(reference.seconds * 1000) : null;

	if (!reference || !date || Number.isNaN(date.getTime())) return null;

	return {
		$type: TIME_FEATURE,
		datetime: date.toISOString(),
		style: reference.style,
	} as Feature;
};

const timeReference = (feature: Record<string, unknown>): RemoteReference | null => {
	const milliseconds = Date.parse(String(feature.datetime));
	const style = TIME_STYLES.find((known) => known === feature.style) ?? "relative";

	if (Number.isNaN(milliseconds)) return null;

	return {
		kind: "time",
		id: timeReferenceId({ seconds: Math.floor(milliseconds / 1000), style }),
	};
};

const skeyOf = (space: string): string => space.split("/").at(-1) ?? space;

const threadName = (name: string): string =>
	[...name.trim()].slice(0, MAX_THREAD_NAME).join("") || FALLBACK_THREAD_NAME;

const quoted = (markdown: string): string =>
	markdown
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");

const silentLogger: BridgeLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

export const registrationKey = (community: string, registration: string): string =>
	`${community} ${registration}`;

export const colibriRecordKey = (key: ColibriRecordKey): string =>
	`${key.channel} ${key.did} ${key.rkey}`;

export const parseColibriRecordKey = (value: string): ColibriRecordKey | null => {
	const [channel, did, rkey] = value.split(" ");
	return channel && did && rkey ? { channel, did, rkey } : null;
};

const remoteLocationKey = (remoteSpace: string, remoteRoom: string): string =>
	`${remoteSpace} ${remoteRoom}`;

class BackfillStopped extends Error {}

class SerialQueues {
	private readonly tails = new Map<string, Promise<void>>();

	run(key: string, task: () => Promise<void>): Promise<void> {
		const next = (this.tails.get(key) ?? Promise.resolve()).then(task, task);
		const settled = next.catch(() => undefined);
		this.tails.set(key, settled);
		void settled.then(() => {
			if (this.tails.get(key) === settled) this.tails.delete(key);
		});
		return settled;
	}

	async drain(): Promise<void> {
		await Promise.all([...this.tails.values()]);
	}
}

export class Bridge {
	private readonly log: BridgeLogger;
	private readonly queues = new SerialQueues();
	private readonly stream: Pick<EventStream, "start" | "stop" | "setChannels">;
	private readonly sleep: (ms: number) => Promise<void>;
	private registrations: RegistrationView[] = [];
	private byChannel = new Map<string, Portal[]>();
	private byRemote = new Map<string, Portal[]>();
	private threads = new Map<string, Portal[]>();
	private openChannels = new Map<string, OpenChannel[]>();
	private openThreads = new Map<string, OpenTarget[]>();
	private openSnapshot: OpenSnapshot | null = null;
	private readonly openDeleted = new BoundedSet(ECHO_CAPACITY);
	private readonly openHidden = new BoundedSet(ECHO_CAPACITY);
	private readonly openThreadEchoes = new BoundedSet(ECHO_CAPACITY);
	private readonly members = new ExpiringCache<MemberStanding>(
		MEMBER_CACHE_CAPACITY,
		MEMBER_CACHE_TTL_MS,
	);
	private readonly backfills = new Map<string, Promise<void>>();
	private refreshing: Promise<void> | null = null;
	private streamOpened = false;
	private stopped = false;

	constructor(private readonly options: BridgeOptions) {
		if (!canRelay(options.connector) && !canOpen(options.connector)) {
			throw new Error(
				`The ${options.connector.platform} connector neither relays rooms nor handles open channels`,
			);
		}

		this.log = options.log ?? silentLogger;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		const streamOptions: EventStreamOptions = {
			client: options.client,
			onFrame: (frame) => this.onFrame(frame),
			onOpen: () => this.onStreamOpen(),
			onClose: (reason) => this.log.warn({ reason }, "bridge.stream.closed"),
			onMove: (move) => this.log.info(move, "bridge.stream.moving"),
		};
		this.stream = options.createEventStream
			? options.createEventStream(streamOptions)
			: new EventStream(streamOptions);
	}

	get context(): BridgeContext {
		return {
			did: this.options.client.did,
			log: this.log,
			emit: (event) => this.emit(event),
			openEmit: (event) => this.openEmit(event),
			pair: (remote) => this.options.client.createPairing({ platform: this.platform, ...remote }),
			linkedRooms: (remoteSpace) =>
				[...this.byRemote.values()]
					.flat()
					.filter((portal) => portal.remoteSpace === remoteSpace)
					.map(({ community, registration, channel, remoteRoom, remoteName }) => ({
						community,
						registration,
						channel,
						remoteRoom,
						remoteName,
					})),
			connections: (remoteSpace) => this.connections(remoteSpace),
			channels: (community, registration) =>
				this.options.client.listChannels({ community, registration }),
			openChannels: (community, registration) => this.openChannelsOf(community, registration),
			message: (ref) => this.openLookup(ref),
			history: (request) => this.openHistory(request),
			member: (ref) => this.member(ref),
			disconnect: (remoteSpace, community) => this.leave(remoteSpace, community),
		};
	}

	private get platform(): string {
		return this.options.connector.platform;
	}

	async start(): Promise<void> {
		this.stopped = false;
		await this.options.connector.start(this.context);
		await this.loadWhenReachable();
		this.stream.start();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.stream.stop();
		await Promise.all([...this.backfills.values()]);
		await this.queues.drain();
		await this.options.connector.stop();
	}

	async idle(): Promise<void> {
		await this.refreshing;
		await Promise.all([...this.backfills.values()]);
		await this.queues.drain();
	}

	private async loadWhenReachable(): Promise<void> {
		for (let attempt = 0; !this.stopped; attempt++) {
			try {
				await this.refresh();
				return;
			} catch (error) {
				const delay = Math.min(1000 * 2 ** attempt, 30_000);
				this.log.warn(
					{ error: error instanceof Error ? error.message : String(error), retryInMs: delay },
					"bridge.configuration.unavailable",
				);
				await this.sleep(delay);
			}
		}
	}

	private onStreamOpen(): void {
		this.log.info({}, "bridge.stream.open");
		if (this.streamOpened) {
			void this.refresh().catch((error) =>
				this.log.warn({ error: String(error) }, "bridge.refreshFailed"),
			);
		}
		this.streamOpened = true;
	}

	refresh(): Promise<void> {
		this.refreshing ??= this.loadConfiguration().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async loadConfiguration(): Promise<void> {
		const all = await this.options.client.getConfiguration();
		this.registrations = all.filter((registration) => registration.platform === this.platform);
		await this.purgeRevoked(all);
		const relaying = canRelay(this.options.connector);
		const byChannel = new Map<string, Portal[]>();
		const byRemote = new Map<string, Portal[]>();
		for (const registration of this.registrations) {
			if (!registration.enabled || !relaying) continue;
			for (const link of registration.links) {
				const portal: Portal = {
					key: `${registrationKey(registration.community, registration.id)} ${link.channel}`,
					community: registration.community,
					registration: registration.id,
					channel: link.channel,
					parentChannel: link.channel,
					remoteRoom: link.remoteRoom,
					remoteName: link.remoteName,
					remoteSpace: registration.remoteSpace,
					platform: registration.platform,
					mirrorModeration: registration.mirrorModeration ?? false,
					links: registration.links,
					...(link.backfill
						? {
								backfill: {
									...(link.backfill.since ? { since: link.backfill.since } : {}),
									requestedAt: link.backfill.requestedAt,
								},
							}
						: {}),
				};
				byChannel.set(link.channel, [...(byChannel.get(link.channel) ?? []), portal]);
				const remote = remoteLocationKey(registration.remoteSpace, link.remoteRoom);
				byRemote.set(remote, [...(byRemote.get(remote) ?? []), portal]);
			}
		}
		const threads = new Map<string, Portal[]>();
		for (const registration of this.registrations) {
			if (!registration.enabled || !relaying) continue;
			const mappings = await this.options.store.list({
				registration: registrationKey(registration.community, registration.id),
				kind: "thread",
			});
			for (const mapping of mappings) {
				const parent = byChannel
					.get(mapping.channel)
					?.find((portal) => portal.registration === registration.id);
				if (!parent) continue;
				threads.set(mapping.rkey, [
					...(threads.get(mapping.rkey) ?? []),
					this.threadPortal(parent, mapping.rkey, mapping.remoteId),
				]);
			}
		}
		this.byChannel = byChannel;
		this.byRemote = byRemote;
		this.threads = threads;
		this.openChannels = this.collectOpenChannels();
		this.openThreads = await this.collectOpenThreads();
		this.subscribe();
		this.announceOpenChannels();
		this.startBackfills();
		for (const registration of this.registrations) {
			if (!relaying) break;
			await this.pushRooms(registration).catch((error) =>
				this.log.warn(
					{ registration: registration.id, error: String(error) },
					"bridge.rooms.pushFailed",
				),
			);
		}
		this.log.info(
			{ registrations: this.registrations.length, channels: byChannel.size },
			"bridge.configured",
		);
	}

	private async purgeRevoked(registrations: RegistrationView[]): Promise<void> {
		const held = new Set(
			registrations.map((registration) => registrationKey(registration.community, registration.id)),
		);
		for (const registration of await this.options.store.registrations()) {
			if (held.has(registration)) continue;
			await this.options.store.purge(registration);
			this.log.info({ registration }, "bridge.registration.purged");
		}
	}

	private connections(remoteSpace: string): BridgeConnection[] {
		return this.registrations
			.filter((registration) => registration.remoteSpace === remoteSpace)
			.map((registration) => ({
				community: registration.community,
				...(registration.communityName ? { communityName: registration.communityName } : {}),
				registration: registration.id,
			}));
	}

	private async leave(remoteSpace: string, community?: string): Promise<number> {
		const leaving = this.registrations.filter(
			(registration) =>
				registration.remoteSpace === remoteSpace &&
				(community === undefined || registration.community === community),
		);
		for (const registration of leaving) {
			try {
				await this.options.client.leave({
					community: registration.community,
					registration: registration.id,
				});
			} catch (error) {
				if (!(error instanceof ColibriRequestError && error.error === "RegistrationNotFound")) {
					throw error;
				}
			}
			this.log.info(
				{ community: registration.community, registration: registration.id },
				"bridge.registration.left",
			);
		}
		if (leaving.length > 0) await this.refresh();
		return leaving.length;
	}

	private async pushRooms(registration: RegistrationView): Promise<void> {
		const connector = this.options.connector;

		if (!canRelay(connector)) return;

		const rooms = await connector.listRooms(registration.remoteSpace);
		await this.options.client.putRemoteRooms(
			{ community: registration.community, registration: registration.id },
			rooms.map((room) => ({
				id: room.id,
				name: room.name,
				...(room.kind ? { kind: room.kind } : {}),
				...(room.parent ? { parent: room.parent } : {}),
			})),
		);
	}

	private subscribe(): void {
		this.stream.setChannels([
			...new Set([
				...this.byChannel.keys(),
				...this.threads.keys(),
				...this.openChannels.keys(),
				...this.openThreads.keys(),
			]),
		]);
	}

	private collectOpenChannels(): Map<string, OpenChannel[]> {
		const open = new Map<string, OpenChannel[]>();

		if (!canOpen(this.options.connector)) return open;

		for (const registration of this.registrations) {
			if (!registration.enabled) continue;
			for (const channel of new Set(registration.channels ?? [])) {
				const entry = {
					community: registration.community,
					registration: registration.id,
					mirrorModeration: registration.mirrorModeration ?? false,
				};

				open.set(channel, [...(open.get(channel) ?? []), entry]);
			}
		}

		return open;
	}

	private async collectOpenThreads(): Promise<Map<string, OpenTarget[]>> {
		const threads = new Map<string, OpenTarget[]>();

		for (const [channel, entries] of this.openChannels) {
			const community = entries[0]?.community;

			if (!community) continue;

			for (const space of await this.listOpenThreads(community, channel)) {
				const targets = entries.map((open) => ({ ...open, channel, thread: space }));

				threads.set(space, [...(threads.get(space) ?? []), ...targets]);
			}
		}

		return threads;
	}

	private async listOpenThreads(community: string, channel: string): Promise<string[]> {
		const spaces: string[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;

		try {
			do {
				const page = await this.options.client.listThreads({
					community,
					channel,
					limit: 100,
					...(cursor ? { cursor } : {}),
				});

				for (const thread of page.threads) {
					if (thread.channel === channel) spaces.push(thread.space);
				}

				cursor = page.threads.length > 0 ? page.cursor : undefined;
				if (cursor && seen.has(cursor)) break;
				if (cursor) seen.add(cursor);
			} while (cursor);
		} catch (error) {
			this.log.warn(
				{ channel, error: error instanceof Error ? error.message : String(error) },
				"bridge.openThreads.listFailed",
			);
		}

		return spaces;
	}

	private announceOpenChannels(): void {
		const next: OpenSnapshot = new Map();

		for (const registration of this.registrations) {
			if (!registration.enabled) continue;
			next.set(registrationKey(registration.community, registration.id), {
				community: registration.community,
				registration: registration.id,
				channels: [...new Set(registration.channels ?? [])],
			});
		}

		const previous = this.openSnapshot;
		const connector = this.options.connector;

		this.openSnapshot = next;

		if (!previous || !canOpenLifecycle(connector)) return;

		const changes: OpenChannelsChange[] = [];

		for (const [key, current] of next) {
			const before = previous.get(key);
			const added = current.channels.filter((channel) => !before?.channels.includes(channel));
			const removed = (before?.channels ?? []).filter(
				(channel) => !current.channels.includes(channel),
			);

			if (before && added.length === 0 && removed.length === 0) continue;

			changes.push({
				community: current.community,
				registration: current.registration,
				kind: before ? "updated" : "installed",
				channels: current.channels,
				added,
				removed,
			});
		}

		for (const [key, before] of previous) {
			if (next.has(key)) continue;
			changes.push({
				community: before.community,
				registration: before.registration,
				kind: "removed",
				channels: [],
				added: [],
				removed: before.channels,
			});
		}

		for (const change of changes) {
			this.openTask(change, `lifecycle.${change.kind}`, () =>
				connector.openChannelsChanged(change),
			);
		}
	}

	private openChannelsOf(community: string, registration: string): string[] {
		return [...this.openChannels]
			.filter(([, entries]) =>
				entries.some((open) => open.community === community && open.registration === registration),
			)
			.map(([channel]) => channel);
	}

	private openTargets(space: string): OpenTarget[] {
		return [
			...(this.openChannels.get(space) ?? []).map((open) => ({ ...open, channel: space })),
			...(this.openThreads.get(space) ?? []),
		];
	}

	private openTargetFor(ref: OpenChannelRef): OpenTarget {
		const open = this.openChannels
			.get(ref.channel)
			?.find((held) => held.community === ref.community && held.registration === ref.registration);

		if (!open) {
			throw new Error(
				`${ref.channel} is not an open channel of registration ${ref.registration} in ${ref.community}`,
			);
		}

		if (
			ref.thread &&
			!this.openThreads
				.get(ref.thread)
				?.some(
					(held) =>
						held.community === ref.community &&
						held.registration === ref.registration &&
						held.channel === ref.channel,
				)
		) {
			throw new Error(`${ref.thread} is not a thread of the open channel ${ref.channel}`);
		}

		return { ...open, channel: ref.channel, ...(ref.thread ? { thread: ref.thread } : {}) };
	}

	private openRef(target: OpenTarget): OpenChannelRef {
		return {
			community: target.community,
			registration: target.registration,
			channel: target.channel,
			...(target.thread ? { thread: target.thread } : {}),
		};
	}

	private echoKey(target: RegistrationRef, ...parts: string[]): string {
		return [registrationKey(target.community, target.registration), ...parts].join(" ");
	}

	private openTask(
		target: RegistrationRef & { channel?: string },
		action: string,
		work: () => Promise<void>,
	): void {
		const key = [
			"open",
			registrationKey(target.community, target.registration),
			...(target.channel ? [target.channel] : []),
		].join(" ");

		void this.queues.run(key, async () => {
			try {
				await work();
			} catch (error) {
				this.log.warn(
					{
						registration: target.registration,
						channel: target.channel,
						action,
						error: error instanceof Error ? error.message : String(error),
					},
					"bridge.openChannel.failed",
				);
			}
		});
	}

	private isOpenEcho(target: OpenTarget, message: MessageView): boolean {
		return (
			message.author.did === target.community &&
			message.author.bridge?.registration === target.registration
		);
	}

	private onOpenMessageFrame(frame: ServerFrame): void {
		const connector = this.options.connector;

		if (!canOpen(connector)) return;

		for (const target of this.openTargets(frame.channel as string)) {
			if (frame.event === "delete") {
				const subject = frame.subject as MessageRef | undefined;

				if (!subject || !canOpenDelete(connector)) continue;
				if (this.openDeleted.has(this.echoKey(target, subject.did, subject.rkey))) continue;
				this.openTask(target, "message.delete", () =>
					connector.openDeleteMessage({ ...this.openRef(target), ...subject }),
				);
				continue;
			}

			const message = frame.message as MessageView | undefined;

			if (!message || this.isOpenEcho(target, message)) continue;

			if (frame.event === "create") {
				this.openTask(target, "message.create", async () =>
					connector.openMessage(await this.openMessage(target, message)),
				);
			} else if (frame.event === "update" && canOpenEdit(connector)) {
				this.openTask(target, "message.update", async () =>
					connector.openEditMessage(await this.openMessage(target, message)),
				);
			}
		}
	}

	private onOpenReactionFrame(frame: ServerFrame): void {
		const connector = this.options.connector;

		if (!canOpenReact(connector)) return;

		const message = frame.target as MessageRef | undefined;
		const bridged = frame.bridged as { registration?: string } | undefined;
		const customEmoji = frame.customEmoji as { uri?: string } | undefined;

		if (!message) return;

		for (const target of this.openTargets(frame.channel as string)) {
			if (bridged?.registration === target.registration) continue;

			const reaction = {
				...this.openRef(target),
				did: message.did,
				rkey: message.rkey,
				emoji: frame.emoji as string,
				actor: frame.actor as string,
				...(customEmoji?.uri ? { customEmoji: { uri: customEmoji.uri } } : {}),
			};

			if (frame.event === "delete") {
				this.openTask(target, "reaction.delete", () => connector.openRemoveReaction(reaction));
			} else {
				this.openTask(target, "reaction.create", () => connector.openAddReaction(reaction));
			}
		}
	}

	private onOpenLabelFrame(space: string, subject: MessageRef): void {
		const connector = this.options.connector;

		if (!canOpenModerate(connector)) return;

		for (const target of this.openTargets(space)) {
			if (this.openHidden.has(this.echoKey(target, subject.did, subject.rkey))) continue;
			this.openTask(target, "label.hidden", () =>
				connector.openRemoveMessage({ ...this.openRef(target), ...subject }),
			);
		}
	}

	private trackOpenThread(target: OpenTarget, space: string): boolean {
		const held = this.openThreads.get(space) ?? [];

		if (held.some((entry) => this.sameRegistration(entry, target))) return false;

		this.openThreads.set(space, [...held, { ...target, thread: space }]);
		this.subscribe();

		return true;
	}

	private untrackOpenThread(target: RegistrationRef, space: string): void {
		const rest = (this.openThreads.get(space) ?? []).filter(
			(entry) => !this.sameRegistration(entry, target),
		);

		if (rest.length > 0) this.openThreads.set(space, rest);
		else this.openThreads.delete(space);
		this.subscribe();
	}

	private sameRegistration(a: RegistrationRef, b: RegistrationRef): boolean {
		return a.community === b.community && a.registration === b.registration;
	}

	private onOpenThreadFrame(frame: ServerFrame): void {
		const connector = this.options.connector;

		if (!canOpen(connector)) return;

		if (frame.event === "delete") {
			if (typeof frame.space !== "string") return;

			const space = frame.space;

			for (const target of this.openThreads.get(space) ?? []) {
				this.untrackOpenThread(target, space);
				if (this.openThreadEchoes.has(this.echoKey(target, "delete", space))) continue;
				if (!canOpenThread(connector)) continue;
				this.openTask(target, "thread.delete", () =>
					connector.openDeleteThread({ ...this.openRef(target), thread: space }),
				);
			}

			return;
		}

		if (frame.event !== "create" && frame.event !== "update") return;

		const thread = frame.thread as ThreadView | undefined;

		if (!thread) return;

		for (const open of this.openChannels.get(thread.channel) ?? []) {
			const target: OpenTarget = { ...open, channel: thread.channel };
			const tracked = this.trackOpenThread(target, thread.space);
			const create = frame.event === "create" || tracked;
			const echo = create
				? this.openThreadEchoes.has(this.echoKey(target, "create", thread.space)) ||
					(thread.createdBy === target.community &&
						this.openThreadEchoes.take(
							this.echoKey(target, "pending", thread.channel, thread.name),
						))
				: this.openThreadEchoes.has(this.echoKey(target, "update", thread.space, thread.name));

			if (echo || !canOpenThread(connector)) continue;

			const change = {
				...this.openRef(target),
				thread: thread.space,
				name: thread.name,
				...(thread.anchor ? { anchor: { did: thread.anchor.did, rkey: thread.anchor.rkey } } : {}),
			};

			this.openTask(target, `thread.${create ? "create" : "update"}`, () =>
				create ? connector.openCreateThread(change) : connector.openUpdateThread(change),
			);
		}
	}

	private async member(ref: MemberRef): Promise<MemberStanding> {
		const key = `${ref.community} ${ref.did} ${ref.channel}`;
		const cached = this.members.get(key);

		if (cached) return cached;

		try {
			const standing = await this.options.client.getMember({
				community: ref.community,
				registration: ref.registration,
				did: ref.did,
				channel: ref.channel,
			});

			this.members.set(key, standing);

			return standing;
		} catch (error) {
			this.log.warn(
				{
					registration: ref.registration,
					channel: ref.channel,
					did: ref.did,
					error: error instanceof Error ? error.message : String(error),
				},
				"bridge.member.failed",
			);

			return { did: ref.did, member: false, owner: false, roles: [], permissions: [] };
		}
	}

	private async openContent(target: OpenTarget, message: MessageView): Promise<OpenChannelContent> {
		const standing = await this.member({
			community: target.community,
			registration: target.registration,
			channel: target.channel,
			did: message.author.did,
		});
		const parent = message.parent as { author?: { did?: string }; rkey?: string } | undefined;
		const forward = message.forward;

		return {
			author: { ...colibriAuthor(message.author), standing },
			markdown: colibriToMarkdown(message.text, message.facets ?? []),
			...(parent?.author?.did && parent.rkey
				? { replyTo: { did: parent.author.did, rkey: parent.rkey } }
				: {}),
			attachments: outboundAttachments(message.attachments),
			embeds: outboundEmbeds(message),
			...(forward
				? {
						forward: {
							markdown: colibriToMarkdown(forward.text, forward.facets ?? []),
							attachments: outboundAttachments(forward.attachments),
							source: {
								channel: forward.source.space,
								did: forward.source.did,
								rkey: forward.source.rkey,
							},
						},
					}
				: {}),
			createdAt: message.createdAt,
			...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
		};
	}

	private async openMessage(target: OpenTarget, message: MessageView): Promise<OpenChannelMessage> {
		return {
			...this.openRef(target),
			did: message.author.did,
			rkey: message.rkey,
			...(await this.openContent(target, message)),
		};
	}

	private async openLookup(ref: OpenChannelInfo): Promise<OpenChannelMessage | null> {
		const target = this.openTargetFor(ref);
		const { messages } = await this.retrying(
			() =>
				this.options.client.listMessages(target.thread ?? target.channel, {
					around: ref.rkey,
					limit: OPEN_MESSAGE_WINDOW,
				}),
			this.emitRetries,
		);
		const found = messages.find(
			(message) => message.rkey === ref.rkey && message.author.did === ref.did,
		);

		return found ? this.openMessage(target, found) : null;
	}

	private async openHistory(request: OpenHistoryRequest): Promise<OpenChannelMessage[]> {
		const target = this.openTargetFor(request);
		const space = target.thread ?? target.channel;
		const limit = Math.min(
			Math.max(request.limit ?? OPEN_HISTORY_LIMIT, 1),
			MAX_OPEN_HISTORY_LIMIT,
		);
		const list = (options: ListMessagesOptions) =>
			this.retrying(() => this.options.client.listMessages(space, options), this.emitRetries);
		const before = request.before;
		let page = await list(before ? { around: before, limit } : { limit });
		const collected = before ? olderThan(page.messages, before) : [...page.messages];

		while (collected.length < limit && page.cursor && page.messages.length > 0) {
			const cursor = page.cursor;

			page = await list({ cursor, limit: limit - collected.length });
			collected.push(...page.messages);
		}

		const built: OpenChannelMessage[] = [];

		for (const message of collected.slice(0, limit)) {
			built.push(await this.openMessage(target, message));
		}

		return built;
	}

	private get emitRetries(): number {
		return this.options.maxRetries ?? 3;
	}

	private async openEmit(event: OpenInboundEvent): Promise<OpenEmitResult> {
		const target = this.openTargetFor(event);
		const ref = { community: target.community, registration: target.registration };
		const space = target.thread ?? target.channel;
		const client = this.options.client;
		const call = <T>(work: () => Promise<T>) => this.retrying(work, this.emitRetries);

		switch (event.type) {
			case "message":
				return this.openPost(target, event);
			case "messageEdit": {
				const { text, facets } = markdownToColibri(event.markdown);

				await call(() =>
					client.editMessage({
						...ref,
						channel: space,
						rkey: event.rkey,
						text,
						...(facets.length > 0 ? { facets } : {}),
					}),
				);

				return { rkey: event.rkey, dropped: [] };
			}
			case "messageDelete":
				this.openDeleted.add(this.echoKey(target, target.community, event.rkey));
				await call(() => client.deleteMessage({ ...ref, channel: space, rkey: event.rkey }));

				return { rkey: event.rkey, dropped: [] };
			case "messageRemove":
				if (!target.mirrorModeration) {
					throw new Error(
						`Registration ${target.registration} may not remove messages because mirrorModeration is off`,
					);
				}

				this.openHidden.add(this.echoKey(target, event.did, event.rkey));
				await call(() =>
					client.hideMessage({
						...ref,
						channel: space,
						subject: { did: event.did, rkey: event.rkey },
						...(event.reason ? { reason: event.reason } : {}),
					}),
				);

				return { dropped: [] };
			case "reactionAdd": {
				const { rkey } = await call(() =>
					client.addReaction({
						...ref,
						channel: space,
						author: { id: event.author.id, name: event.author.name },
						target: { did: event.did, rkey: event.rkey },
						emoji: event.emoji,
					}),
				);

				return { rkey, dropped: [] };
			}
			case "reactionRemove":
				await call(() => client.removeReaction({ ...ref, channel: space, rkey: event.rkey }));

				return { rkey: event.rkey, dropped: [] };
			case "threadCreate": {
				const name = threadName(event.name);
				const avatar = await this.avatarFor(ref, event.author);

				this.openThreadEchoes.add(this.echoKey(target, "pending", target.channel, name));

				const { thread } = await call(() =>
					client.createThread({
						...ref,
						channel: target.channel,
						name,
						author: { id: event.author.id, name: event.author.name, ...(avatar ? { avatar } : {}) },
						...(event.anchor ? { anchor: event.anchor } : {}),
					}),
				);

				this.openThreadEchoes.add(this.echoKey(target, "create", thread));
				this.trackOpenThread({ ...target, thread }, thread);

				return { thread, dropped: [] };
			}
			case "threadUpdate": {
				const name = threadName(event.name);

				this.openThreadEchoes.add(this.echoKey(target, "update", event.thread, name));
				await call(() => client.updateThread({ ...ref, thread: event.thread, name }));

				return { thread: event.thread, dropped: [] };
			}
			case "threadDelete":
				this.openThreadEchoes.add(this.echoKey(target, "delete", event.thread));
				await call(() => client.deleteThread({ ...ref, thread: event.thread }));
				this.untrackOpenThread(target, event.thread);

				return { thread: event.thread, dropped: [] };
			default:
				throw new Error(`Unknown open channel event ${(event as { type: string }).type}`);
		}
	}

	private async openPost(
		target: OpenTarget,
		event: Extract<OpenInboundEvent, { type: "message" }>,
	): Promise<OpenEmitResult> {
		const ref = { community: target.community, registration: target.registration };
		const forwarded = event.forward ? await this.openForward(ref, event.forward) : null;
		const markdown = [event.markdown, forwarded?.quote]
			.filter((part): part is string => Boolean(part?.trim()))
			.join("\n\n");
		const { text, facets } = markdownToColibri(markdown);
		const own = await this.attachmentsFor(ref, event.attachments);
		const attachments = [...own.attachments, ...(forwarded?.attachments ?? [])];
		const dropped = [...own.dropped, ...(forwarded?.dropped ?? [])];
		const forward = forwarded?.forward;

		if (text.trim().length === 0 && attachments.length === 0 && !forward) return { dropped };

		const avatar = await this.avatarFor(ref, event.author);
		const { rkey } = await this.retrying(
			() =>
				this.options.client.postMessage({
					...ref,
					channel: target.thread ?? target.channel,
					author: {
						id: event.author.id,
						name: event.author.name,
						...(avatar ? { avatar } : {}),
					},
					text,
					...(facets.length > 0 ? { facets } : {}),
					...(event.replyTo
						? { parent: { did: event.replyTo.did, rkey: event.replyTo.rkey } }
						: {}),
					...(attachments.length > 0 ? { attachments } : {}),
					...(forward ? { forward } : {}),
				}),
			this.emitRetries,
		);

		return { rkey, dropped };
	}

	private async openForward(
		ref: RegistrationRef,
		forward: OpenChannelForwardInput,
	): Promise<AttachmentResult & { forward?: ForwardInput; quote?: string }> {
		const uploaded = await this.attachmentsFor(ref, forward.attachments);

		if (!forward.source) {
			return {
				...(forward.markdown.trim() ? { quote: quoted(forward.markdown) } : {}),
				...uploaded,
			};
		}

		const { text, facets } = markdownToColibri(forward.markdown);

		return {
			forward: {
				source: {
					space: forward.source.channel,
					did: forward.source.did,
					rkey: forward.source.rkey,
				},
				createdAt: forward.createdAt ?? new Date().toISOString(),
				text,
				...(facets.length > 0 ? { facets } : {}),
				...(uploaded.attachments.length > 0 ? { attachments: uploaded.attachments } : {}),
			},
			attachments: [],
			dropped: uploaded.dropped,
		};
	}

	private threadPortal(parent: Portal, space: string, remoteThread: string): Portal {
		return { ...parent, channel: space, parentChannel: parent.channel, remoteThread };
	}

	private addThread(parent: Portal, space: string, remoteThread: string): Portal {
		const held = this.threads.get(space) ?? [];
		const existing = held.find((portal) => portal.key === parent.key);
		if (existing) return existing;
		const portal = this.threadPortal(parent, space, remoteThread);
		this.threads.set(space, [...held, portal]);
		this.subscribe();
		return portal;
	}

	private dropThread(space: string, portal: Portal): void {
		const rest = (this.threads.get(space) ?? []).filter((held) => held.key !== portal.key);
		if (rest.length > 0) this.threads.set(space, rest);
		else this.threads.delete(space);
		this.subscribe();
	}

	private portalsFor(space: string): Portal[] {
		return this.byChannel.get(space) ?? this.threads.get(space) ?? [];
	}

	private location(portal: Portal): RemoteLocation {
		return {
			remoteSpace: portal.remoteSpace,
			remoteRoom: portal.remoteRoom,
			...(portal.remoteThread ? { remoteThread: portal.remoteThread } : {}),
		};
	}

	private resolver(portal: Portal): (reference: RemoteReference) => Feature | null {
		return (reference) => {
			if (reference.kind === "time") return timeFeature(reference.id);
			if (reference.kind === "room") {
				const link = portal.links.find((held) => held.remoteRoom === reference.id);
				return link ? ({ $type: CHANNEL_FEATURE, channel: skeyOf(link.channel) } as Feature) : null;
			}
			return {
				$type: BRIDGED_MENTION_FEATURE,
				registration: portal.registration,
				platform: portal.platform,
				remoteId: reference.id,
			} as Feature;
		};
	}

	private referrer(portal: Portal): (feature: Feature) => RemoteReference | null {
		return (feature) => {
			const value = feature as Feature & Record<string, unknown>;
			if (value.$type === TIME_FEATURE) return timeReference(value);
			if (value.$type === CHANNEL_FEATURE) {
				const link = portal.links.find((held) => skeyOf(held.channel) === value.channel);
				return link ? { kind: "room", id: link.remoteRoom } : null;
			}
			if (value.$type === BRIDGED_MENTION_FEATURE && value.registration === portal.registration) {
				return { kind: "user", id: String(value.remoteId) };
			}
			return null;
		};
	}

	emit(event: InboundEvent): void {
		if (!canRelay(this.options.connector)) return;
		if (event.type === "roomsChanged") {
			for (const registration of this.registrations) {
				if (registration.remoteSpace !== event.remoteSpace) continue;
				void this.pushRooms(registration).catch((error) =>
					this.log.warn({ error: String(error) }, "bridge.rooms.pushFailed"),
				);
			}
			return;
		}
		if (event.type === "spaceLeft") {
			void this.leave(event.remoteSpace).catch((error) =>
				this.log.warn(
					{ remoteSpace: event.remoteSpace, error: String(error) },
					"bridge.registration.leaveFailed",
				),
			);
			return;
		}
		for (const portal of this.byRemote.get(
			remoteLocationKey(event.remoteSpace, event.remoteRoom),
		) ?? []) {
			void this.queues.run(portal.key, () =>
				this.guard(portal, event.type, () => this.inbound(portal, event)),
			);
		}
	}

	private onFrame(frame: ServerFrame): void {
		switch (frameKind(frame)) {
			case "bridgeEvent":
				void this.refresh().catch((error) =>
					this.log.warn({ error: String(error) }, "bridge.refreshFailed"),
				);
				return;
			case "messageEvent":
				this.onMessageFrame(frame);
				return;
			case "reactionEvent":
				this.onReactionFrame(frame);
				return;
			case "threadEvent":
				this.onThreadFrame(frame);
				return;
			case "labelEvent":
				this.onLabelFrame(frame);
				return;
			case "error":
				this.log.warn({ frame }, "bridge.stream.error");
				return;
			default:
				return;
		}
	}

	private onMessageFrame(frame: ServerFrame): void {
		if (frame.imported === true) return;
		const channel = frame.channel as string;
		this.onOpenMessageFrame(frame);
		for (const portal of this.portalsFor(channel)) {
			void this.queues.run(portal.key, () =>
				this.guard(portal, `colibri.message.${String(frame.event)}`, async () => {
					if (frame.event === "delete") {
						const subject = frame.subject as { did: string; rkey: string };
						await this.outboundDelete(portal, subject);
						return;
					}
					await this.outboundMessage(portal, frame.message as MessageView);
				}),
			);
		}
	}

	private onReactionFrame(frame: ServerFrame): void {
		const channel = frame.channel as string;
		this.onOpenReactionFrame(frame);
		for (const portal of this.portalsFor(channel)) {
			void this.queues.run(portal.key, () =>
				this.guard(portal, `colibri.reaction.${String(frame.event)}`, () =>
					this.outboundReaction(portal, frame),
				),
			);
		}
	}

	private onThreadFrame(frame: ServerFrame): void {
		this.onOpenThreadFrame(frame);
		const action = `colibri.thread.${String(frame.event)}`;
		if (frame.event === "create" || frame.event === "update") {
			const thread = frame.thread as ThreadView | undefined;
			if (!thread) return;
			for (const parent of this.byChannel.get(thread.channel) ?? []) {
				void this.queues.run(parent.key, () =>
					this.guard(parent, action, () => this.outboundThread(parent, thread)),
				);
			}
			return;
		}
		if (frame.event !== "delete" || typeof frame.space !== "string") return;
		const space = frame.space;
		for (const portal of this.threads.get(space) ?? []) {
			void this.queues.run(portal.key, () =>
				this.guard(portal, action, () => this.outboundThreadDelete(space, portal)),
			);
		}
	}

	private onLabelFrame(frame: ServerFrame): void {
		if (frame.event !== "create" || frame.val !== "hidden") return;
		const subject = frame.subject as { did?: string; collection?: string; rkey?: string };
		if (subject.collection !== "social.colibri.beta.message" || !subject.did || !subject.rkey) {
			return;
		}
		const target = { did: subject.did, rkey: subject.rkey };
		this.onOpenLabelFrame(frame.space as string, target);
		for (const portal of this.portalsFor(frame.space as string)) {
			void this.queues.run(portal.key, () =>
				this.guard(portal, "colibri.label.hidden", () => this.outboundHide(portal, target)),
			);
		}
	}

	private async guard(portal: Portal, action: string, work: () => Promise<void>): Promise<void> {
		const attempts = (this.options.maxRetries ?? 3) + 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				await work();
				return;
			} catch (error) {
				const retryable =
					error instanceof ColibriRequestError && (error.status === 429 || error.status >= 500);
				if (retryable && attempt < attempts) {
					await this.sleep((error.retryAfterSeconds ?? 2 ** attempt) * 1000);
					continue;
				}
				this.log.warn(
					{
						action,
						channel: portal.channel,
						registration: portal.registration,
						error: error instanceof Error ? error.message : String(error),
						...(error instanceof ColibriRequestError ? { code: error.error } : {}),
					},
					"bridge.action.failed",
				);
				return;
			}
		}
	}

	private ref(owner: RegistrationRef): RegistrationRef {
		return { community: owner.community, registration: owner.registration };
	}

	private mappingRegistration(owner: RegistrationRef): string {
		return registrationKey(owner.community, owner.registration);
	}

	private async inbound(parent: Portal, event: InboundEvent): Promise<void> {
		switch (event.type) {
			case "threadCreate":
				await this.ensureThread(parent, event, event.author);
				return;
			case "threadUpdate":
				await this.inboundThreadUpdate(parent, event.id, event.name);
				return;
			case "threadDelete":
				await this.inboundThreadDelete(parent, event.id);
				return;
			case "roomsChanged":
			case "spaceLeft":
				return;
			default:
				break;
		}
		const thread = event.type === "message" ? event.thread : undefined;
		const remoteThread = thread?.id ?? event.remoteThread;
		const portal = !remoteThread
			? parent
			: thread && event.type === "message"
				? await this.ensureThread(parent, thread, event.author)
				: await this.knownThread(parent, remoteThread);
		if (!portal) return;
		switch (event.type) {
			case "message":
				await this.inboundMessage(portal, event);
				return;
			case "messageEdit":
				await this.inboundEdit(portal, event.id, event.markdown);
				return;
			case "messageDelete":
				await this.inboundDelete(portal, event.id);
				return;
			case "reactionAdd":
				await this.inboundReactionAdd(portal, event.messageId, event.author, event.emoji);
				return;
			case "reactionRemove":
				await this.inboundReactionRemove(portal, event.messageId, event.authorId, event.emoji);
				return;
			default:
				return;
		}
	}

	private async avatarFor(
		owner: RegistrationRef,
		author: RemoteAuthor,
	): Promise<BlobRef | undefined> {
		const { store } = this.options;
		const registration = this.mappingRegistration(owner);
		const cached = await store.avatar(registration, author.id);
		if (cached && cached.url === author.avatarUrl) return cached.blob;
		if (!author.avatarUrl) {
			if (cached) {
				await store.removeAvatar(registration, author.id);
				this.replaceAvatar(owner, author.id);
			}
			return undefined;
		}
		try {
			const { bytes, mimeType } = await this.options.client.fetchBytes(author.avatarUrl);
			const blob = await this.options.client.uploadBlob(this.ref(owner), bytes, mimeType);
			await store.putAvatar(registration, author.id, { url: author.avatarUrl, blob });
			if (cached) this.replaceAvatar(owner, author.id, blob);
			return blob;
		} catch (error) {
			this.log.debug({ error: String(error) }, "bridge.avatar.failed");
			return undefined;
		}
	}

	private replaceAvatar(owner: RegistrationRef, remoteId: string, avatar?: BlobRef): void {
		const registration = this.mappingRegistration(owner);
		void this.queues.run(`${registration} avatars`, async () => {
			try {
				const updated = await this.options.client.replaceAvatar({
					...this.ref(owner),
					remoteId,
					...(avatar ? { avatar } : {}),
				});
				this.log.debug({ registration, remoteId, updated }, "bridge.avatar.replaced");
			} catch (error) {
				this.log.warn(
					{ registration, remoteId, error: String(error) },
					"bridge.avatar.replaceFailed",
				);
			}
		});
	}

	private async attachmentsFor(
		owner: RegistrationRef,
		attachments: ReadonlyArray<RemoteAttachment> = [],
	): Promise<AttachmentResult> {
		const out: AttachmentInput[] = [];
		const dropped: DroppedAttachment[] = [];
		const limit = this.options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
		const drop = (attachment: RemoteAttachment, reason: DroppedAttachment["reason"]) => {
			dropped.push({ ...attachment, reason });
			this.log.warn(
				{ registration: owner.registration, url: attachment.url, reason },
				"bridge.attachment.dropped",
			);
		};

		for (const attachment of attachments) {
			if (attachment.size !== undefined && attachment.size > limit) {
				drop(attachment, "tooLarge");
				continue;
			}

			let fetched: { bytes: Uint8Array; mimeType: string };

			try {
				fetched = await this.options.client.fetchBytes(attachment.url);
			} catch {
				drop(attachment, "fetchFailed");
				continue;
			}

			if (fetched.bytes.byteLength > limit) {
				drop(attachment, "tooLarge");
				continue;
			}

			try {
				const blob = await this.options.client.uploadBlob(
					this.ref(owner),
					fetched.bytes,
					fetched.mimeType,
				);

				out.push({
					blob,
					...(attachment.name ? { name: attachment.name } : {}),
					...(attachment.alt ? { alt: attachment.alt } : {}),
					...(attachment.spoiler ? { spoiler: true } : {}),
				});
			} catch {
				drop(attachment, "uploadFailed");
			}
		}

		return { attachments: out, dropped };
	}

	private async ensureThread(
		parent: Portal,
		thread: RemoteThread,
		author: RemoteAuthor,
		createdAt?: string,
	): Promise<Portal | null> {
		const registration = this.mappingRegistration(parent);
		const known = await this.options.store.byRemote({
			registration,
			kind: "thread",
			remoteId: thread.id,
		});
		if (known) return this.addThread(parent, known.rkey, thread.id);

		const anchorMapping = thread.anchor
			? await this.options.store.byRemote({
					registration,
					kind: "message",
					remoteId: thread.anchor,
				})
			: null;
		const anchorKey = anchorMapping ? parseColibriRecordKey(anchorMapping.rkey) : null;
		const anchor = anchorKey?.channel === parent.channel ? anchorKey : null;
		const avatar = await this.avatarFor(parent, author);

		const { thread: space } = await this.options.client.createThread({
			...this.ref(parent),
			channel: parent.channel,
			name: threadName(thread.name),
			author: { id: author.id, name: author.name, ...(avatar ? { avatar } : {}) },
			...(anchor ? { anchor: { did: anchor.did, rkey: anchor.rkey } } : {}),
			remoteThread: thread.id,
			...(createdAt ? { createdAt } : {}),
		});
		await this.options.store.put({
			registration,
			channel: parent.channel,
			kind: "thread",
			remoteId: thread.id,
			rkey: space,
			origin: "remote",
		});
		return this.addThread(parent, space, thread.id);
	}

	private async knownThread(parent: Portal, remoteThread: string): Promise<Portal | null> {
		const mapping = await this.options.store.byRemote({
			registration: this.mappingRegistration(parent),
			kind: "thread",
			remoteId: remoteThread,
		});
		return mapping ? this.addThread(parent, mapping.rkey, remoteThread) : null;
	}

	private async inboundThreadUpdate(parent: Portal, id: string, name: string): Promise<void> {
		const mapping = await this.options.store.byRemote({
			registration: this.mappingRegistration(parent),
			kind: "thread",
			remoteId: id,
		});
		if (mapping?.origin !== "remote") return;
		await this.options.client.updateThread({
			...this.ref(parent),
			thread: mapping.rkey,
			name: threadName(name),
		});
	}

	private async inboundThreadDelete(parent: Portal, id: string): Promise<void> {
		const registration = this.mappingRegistration(parent);
		const mapping = await this.options.store.byRemote({
			registration,
			kind: "thread",
			remoteId: id,
		});
		if (!mapping) return;
		if (mapping.origin === "remote") {
			await this.options.client.deleteThread({ ...this.ref(parent), thread: mapping.rkey });
		}
		await this.options.store.remove({ registration, kind: "thread", rkey: mapping.rkey });
		this.dropThread(mapping.rkey, parent);
	}

	private async forwardFor(
		portal: Portal,
		forward: NonNullable<Extract<InboundEvent, { type: "message" }>["forward"]>,
	): Promise<{ forward?: ForwardInput; quote?: string; attachments: AttachmentInput[] }> {
		const { attachments } = await this.attachmentsFor(portal, forward.attachments);
		const source = forward.remoteMessage
			? await this.options.store.byRemote({
					registration: this.mappingRegistration(portal),
					kind: "message",
					remoteId: forward.remoteMessage,
				})
			: null;
		const key = source ? parseColibriRecordKey(source.rkey) : null;
		if (!key) {
			return {
				...(forward.markdown.trim() ? { quote: quoted(forward.markdown) } : {}),
				attachments,
			};
		}
		const { text, facets } = markdownToColibri(forward.markdown, this.resolver(portal));
		return {
			forward: {
				source: { space: key.channel, did: key.did, rkey: key.rkey },
				createdAt: forward.createdAt ?? new Date().toISOString(),
				text,
				...(facets.length > 0 ? { facets } : {}),
				...(attachments.length > 0 ? { attachments } : {}),
			},
			attachments: [],
		};
	}

	private async prepared(portal: Portal, message: InboundMessage): Promise<PreparedMessage | null> {
		const registration = this.mappingRegistration(portal);
		const forwarded = message.forward ? await this.forwardFor(portal, message.forward) : null;
		const markdown = [message.markdown, forwarded?.quote]
			.filter((part): part is string => Boolean(part?.trim()))
			.join("\n\n");
		const { text, facets } = markdownToColibri(markdown, this.resolver(portal));
		const attachments = [
			...(await this.attachmentsFor(portal, message.attachments)).attachments,
			...(forwarded?.attachments ?? []),
		];
		const forward = forwarded?.forward;
		if (text.trim().length === 0 && attachments.length === 0 && !forward) return null;

		const parentMapping = message.replyTo
			? await this.options.store.byRemote({
					registration,
					kind: "message",
					remoteId: message.replyTo,
				})
			: null;
		const parent = parentMapping ? parseColibriRecordKey(parentMapping.rkey) : null;
		const avatar = await this.avatarFor(portal, message.author);
		return {
			author: {
				id: message.author.id,
				name: message.author.name,
				...(avatar ? { avatar } : {}),
			},
			text,
			...(facets.length > 0 ? { facets } : {}),
			...(parent ? { parent: { did: parent.did, rkey: parent.rkey } } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
			...(forward ? { forward } : {}),
		};
	}

	private async mapMessage(portal: Portal, remoteId: string, rkey: string): Promise<void> {
		await this.options.store.put({
			registration: this.mappingRegistration(portal),
			channel: portal.channel,
			kind: "message",
			remoteId,
			rkey: colibriRecordKey({ channel: portal.channel, did: portal.community, rkey }),
			origin: "remote",
		});
	}

	private async inboundMessage(
		portal: Portal,
		event: Extract<InboundEvent, { type: "message" }>,
	): Promise<void> {
		const existing = await this.options.store.byRemote({
			registration: this.mappingRegistration(portal),
			kind: "message",
			remoteId: event.id,
		});
		if (existing) return;

		const message = await this.prepared(portal, event);
		if (!message) return;
		const { rkey } = await this.options.client.postMessage({
			...this.ref(portal),
			channel: portal.channel,
			...message,
			remoteMessage: event.id,
			...(event.createdAt ? { createdAt: event.createdAt } : {}),
		});
		await this.mapMessage(portal, event.id, rkey);
	}

	private startBackfills(): void {
		const connector = this.options.connector;
		if (!canImportHistory(connector)) return;
		for (const portal of [...this.byChannel.values()].flat()) {
			const request = portal.backfill;
			if (!request) continue;
			const key = `${portal.key} ${request.requestedAt}`;
			if (this.backfills.has(key)) continue;
			const run = this.backfill(connector, portal, key).finally(() => this.backfills.delete(key));
			this.backfills.set(key, run);
		}
	}

	private async backfill(connector: HistoryConnector, parent: Portal, key: string): Promise<void> {
		const request = parent.backfill;
		if (!request) return;
		const store = this.options.store;
		const stored = await store.backfill(key);
		if (stored && stored.state !== "running") return;
		const job: BackfillJob = {
			connector,
			parent,
			key,
			...(request.since ? { since: request.since } : {}),
			until: request.requestedAt,
			progress: stored ?? {
				state: "running",
				from: request.since ?? request.requestedAt,
				until: request.requestedAt,
				threadsDone: [],
				imported: 0,
			},
			reportedAt: 0,
		};
		try {
			if (!stored) {
				if (!request.since) {
					job.progress.from = await this.retrying(() =>
						connector.roomCreatedAt(this.location(parent)),
					);
				}
				await store.putBackfill(key, job.progress);
			}
			await this.report(job, true);
			await this.backfillRoom(job);
			job.progress.state = "done";
		} catch (error) {
			if (error instanceof BackfillStopped) return;
			job.progress.state = "failed";
			this.log.warn(
				{
					channel: parent.channel,
					registration: parent.registration,
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof ColibriRequestError ? { code: error.error } : {}),
				},
				"bridge.backfill.failed",
			);
		}
		await store.putBackfill(key, job.progress);
		await this.report(job, true);
	}

	private async backfillRoom(job: BackfillJob): Promise<void> {
		const { connector, parent, progress } = job;
		const threads = (
			await this.retrying(() =>
				connector.listThreads({
					...this.location(parent),
					...(job.since ? { since: job.since } : {}),
					until: job.until,
				}),
			)
		)
			.filter(
				(thread) => thread.createdAt <= job.until && !progress.threadsDone.includes(thread.id),
			)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		await this.walk(job, parent, {
			cursor: () => progress.cursor,
			advance: (last) => {
				progress.cursor = last.id;
				progress.reached = last.createdAt;
			},
			before: async (message, flush) => {
				while (threads[0] && threads[0].createdAt <= message.createdAt) {
					await flush();
					const thread = threads.shift();
					if (thread) await this.backfillThread(job, thread);
				}
			},
		});
		for (const thread of threads) await this.backfillThread(job, thread);
	}

	private async backfillThread(job: BackfillJob, thread: HistoryThread): Promise<void> {
		const { parent, progress } = job;
		if (progress.thread?.id !== thread.id) progress.thread = { id: thread.id };
		const portal = await this.onQueue(parent.key, () =>
			this.retrying(() => this.ensureThread(parent, thread, thread.author, thread.createdAt)),
		);
		if (portal) {
			await this.walk(job, portal, {
				cursor: () => progress.thread?.cursor,
				advance: (last) => {
					progress.thread = { id: thread.id, cursor: last.id };
				},
			});
		}
		progress.threadsDone.push(thread.id);
		delete progress.thread;
		await this.options.store.putBackfill(job.key, progress);
	}

	private async walk(
		job: BackfillJob,
		portal: Portal,
		steps: {
			cursor: () => string | undefined;
			advance: (last: HistoryMessage) => void;
			before?: (message: HistoryMessage, flush: () => Promise<void>) => Promise<void>;
		},
	): Promise<void> {
		const size = this.options.backfillBatchSize ?? DEFAULT_BACKFILL_BATCH_SIZE;
		let batch: HistoryMessage[] = [];
		const flush = async () => {
			const held = batch;
			batch = [];
			await this.importBatch(job, portal, held, steps.advance);
		};
		for (;;) {
			const after = steps.cursor();
			const page = await this.retrying(() =>
				job.connector.fetchHistory({
					...this.location(portal),
					...(job.since && !portal.remoteThread ? { since: job.since } : {}),
					until: job.until,
					...(after ? { after } : {}),
				}),
			);
			const due = page.filter((message) => message.createdAt <= job.until);
			if (due.length === 0) return;
			for (const message of due) {
				if (this.stopped) throw new BackfillStopped();
				await steps.before?.(message, flush);
				const needsEarlier = batch.some(
					(held) => held.id === message.replyTo || held.id === message.forward?.remoteMessage,
				);
				if (batch.length >= size || needsEarlier) await flush();
				batch.push(message);
			}
			await flush();
			if (due.length < page.length) return;
		}
	}

	private async importBatch(
		job: BackfillJob,
		portal: Portal,
		batch: HistoryMessage[],
		advance: (last: HistoryMessage) => void,
	): Promise<void> {
		const last = batch.at(-1);
		if (!last) return;
		if (this.stopped || !this.requested(job)) throw new BackfillStopped();
		await this.onQueue(portal.key, async () => {
			const registration = this.mappingRegistration(portal);
			const messages: ImportedMessageInput[] = [];
			for (const message of batch) {
				const known = await this.options.store.byRemote({
					registration,
					kind: "message",
					remoteId: message.id,
				});
				if (known) continue;
				const prepared = await this.retrying(() => this.prepared(portal, message));
				if (prepared) {
					messages.push({ ...prepared, remoteMessage: message.id, createdAt: message.createdAt });
				}
			}
			if (messages.length > 0) {
				const results = await this.retrying(() =>
					this.options.client.importMessages({
						...this.ref(portal),
						channel: portal.channel,
						messages,
					}),
				);
				for (const result of results)
					await this.mapMessage(portal, result.remoteMessage, result.rkey);
				job.progress.imported += results.length;
			}
			advance(last);
			await this.options.store.putBackfill(job.key, job.progress);
		});
		await this.report(job, false);
	}

	private async report(job: BackfillJob, force: boolean): Promise<void> {
		const now = Date.now();
		const interval = this.options.backfillReportIntervalMs ?? DEFAULT_BACKFILL_REPORT_INTERVAL_MS;
		if (!force && now - job.reportedAt < interval) return;
		job.reportedAt = now;
		const { progress, parent } = job;
		await this.options.client
			.reportBackfill({
				...this.ref(parent),
				channel: parent.channel,
				requestedAt: job.until,
				state: progress.state,
				imported: progress.imported,
				from: progress.from,
				until: progress.until,
				...(progress.reached ? { reached: progress.reached } : {}),
			})
			.catch((error) => this.log.debug({ error: String(error) }, "bridge.backfill.reportFailed"));
	}

	private requested(job: BackfillJob): boolean {
		return (this.byChannel.get(job.parent.channel) ?? []).some(
			(portal) => portal.key === job.parent.key && portal.backfill?.requestedAt === job.until,
		);
	}

	private onQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			void this.queues.run(key, () => work().then(resolve, reject));
		});
	}

	private async retrying<T>(work: () => Promise<T>, retries = BACKFILL_RETRIES): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await work();
			} catch (error) {
				const retryable =
					error instanceof ColibriRequestError && (error.status === 429 || error.status >= 500);
				if (!retryable || attempt > retries || this.stopped) throw error;
				await this.sleep((error.retryAfterSeconds ?? Math.min(2 ** attempt, 60)) * 1000);
			}
		}
	}

	private async inboundEdit(portal: Portal, id: string, markdown: string): Promise<void> {
		const mapping = await this.options.store.byRemote({
			registration: this.mappingRegistration(portal),
			kind: "message",
			remoteId: id,
		});
		const target = mapping?.origin === "remote" ? parseColibriRecordKey(mapping.rkey) : null;
		if (!target) return;
		const { text, facets } = markdownToColibri(markdown, this.resolver(portal));
		await this.options.client.editMessage({
			...this.ref(portal),
			channel: portal.channel,
			rkey: target.rkey,
			text,
			...(facets.length > 0 ? { facets } : {}),
		});
	}

	private async inboundDelete(portal: Portal, id: string): Promise<void> {
		const registration = this.mappingRegistration(portal);
		const mapping = await this.options.store.byRemote({
			registration,
			kind: "message",
			remoteId: id,
		});
		if (!mapping) return;
		const target = parseColibriRecordKey(mapping.rkey);
		if (mapping.origin === "remote" && target) {
			await this.options.client.deleteMessage({
				...this.ref(portal),
				channel: portal.channel,
				rkey: target.rkey,
			});
		}
		if (mapping.origin === "colibri" && target && portal.mirrorModeration) {
			await this.options.client.hideMessage({
				...this.ref(portal),
				channel: portal.channel,
				subject: { did: target.did, rkey: target.rkey },
				reason: `Removed by a moderator on ${this.platform}`,
			});
		}
		await this.options.store.remove({ registration, kind: "message", rkey: mapping.rkey });
	}

	private async inboundReactionAdd(
		portal: Portal,
		messageId: string,
		author: RemoteAuthor,
		emoji: string,
	): Promise<void> {
		const registration = this.mappingRegistration(portal);
		const message = await this.options.store.byRemote({
			registration,
			kind: "message",
			remoteId: messageId,
		});
		const target = message ? parseColibriRecordKey(message.rkey) : null;
		if (!target) return;
		const remoteId = `${messageId} ${author.id} ${emoji}`;
		if (await this.options.store.byRemote({ registration, kind: "reaction", remoteId })) return;

		let rkey: string;
		try {
			({ rkey } = await this.options.client.addReaction({
				...this.ref(portal),
				channel: portal.channel,
				author: { id: author.id, name: author.name },
				target: { did: target.did, rkey: target.rkey },
				emoji,
			}));
		} catch (error) {
			if (error instanceof ColibriRequestError && error.error === "AlreadyReacted") return;
			throw error;
		}
		await this.options.store.put({
			registration,
			channel: portal.channel,
			kind: "reaction",
			remoteId,
			rkey: colibriRecordKey({ channel: portal.channel, did: portal.community, rkey }),
			origin: "remote",
		});
	}

	private async inboundReactionRemove(
		portal: Portal,
		messageId: string,
		authorId: string,
		emoji: string,
	): Promise<void> {
		const registration = this.mappingRegistration(portal);
		const mapping = await this.options.store.byRemote({
			registration,
			kind: "reaction",
			remoteId: `${messageId} ${authorId} ${emoji}`,
		});
		const target = mapping ? parseColibriRecordKey(mapping.rkey) : null;
		if (!mapping || !target) return;
		await this.options.client.removeReaction({
			...this.ref(portal),
			channel: portal.channel,
			rkey: target.rkey,
		});
		await this.options.store.remove({ registration, kind: "reaction", rkey: mapping.rkey });
	}

	private isOwnEcho(portal: Portal, author: { did: string; bridgeRegistration?: string }): boolean {
		return author.did === portal.community && author.bridgeRegistration === portal.registration;
	}

	private async outboundMessage(portal: Portal, message: MessageView): Promise<void> {
		const connector = this.options.connector;

		if (!canRelay(connector)) return;
		if (
			this.isOwnEcho(portal, {
				did: message.author.did,
				bridgeRegistration: message.author.bridge?.registration,
			})
		) {
			return;
		}

		const registration = this.mappingRegistration(portal);
		const key = colibriRecordKey({
			channel: portal.channel,
			did: message.author.did,
			rkey: message.rkey,
		});
		const existing = await this.options.store.byColibri({
			registration,
			kind: "message",
			rkey: key,
		});
		const author = colibriAuthor(message.author);
		const markdown = colibriToMarkdown(message.text, message.facets ?? [], this.referrer(portal));
		const embeds = outboundEmbeds(message);

		if (existing) {
			if (!message.updatedAt || existing.origin !== "colibri") return;
			if (!canEdit(connector)) return;
			await connector.editMessage({
				...this.location(portal),
				id: existing.remoteId,
				author,
				markdown,
				embeds,
			});
			return;
		}

		const parent = message.parent as { author?: { did?: string }; rkey?: string } | undefined;
		const replyMapping =
			parent?.author?.did && parent.rkey
				? await this.options.store.byColibri({
						registration,
						kind: "message",
						rkey: colibriRecordKey({
							channel: portal.channel,
							did: parent.author.did,
							rkey: parent.rkey,
						}),
					})
				: null;

		const forward = message.forward ? await this.outboundForward(portal, message.forward) : null;
		const remoteId = await connector.sendMessage({
			...this.location(portal),
			author,
			markdown,
			...(replyMapping ? { replyTo: replyMapping.remoteId } : {}),
			attachments: outboundAttachments(message.attachments),
			embeds,
			...(forward ? { forward } : {}),
		});
		await this.options.store.put({
			registration,
			channel: portal.channel,
			kind: "message",
			remoteId,
			rkey: key,
			origin: "colibri",
		});
	}

	private async outboundDelete(portal: Portal, subject: { did: string; rkey: string }) {
		const registration = this.mappingRegistration(portal);
		const key = colibriRecordKey({ channel: portal.channel, ...subject });
		const mapping = await this.options.store.byColibri({
			registration,
			kind: "message",
			rkey: key,
		});
		if (!mapping) return;
		if (mapping.origin === "colibri" && canDelete(this.options.connector)) {
			await this.options.connector.deleteMessage({
				...this.location(portal),
				id: mapping.remoteId,
			});
		}
		await this.options.store.remove({ registration, kind: "message", rkey: key });
	}

	private async outboundForward(
		portal: Portal,
		forward: NonNullable<MessageView["forward"]>,
	): Promise<OutboundForward> {
		const source = forward.source;
		const mapping = await this.options.store.byColibri({
			registration: this.mappingRegistration(portal),
			kind: "message",
			rkey: colibriRecordKey({ channel: source.space, did: source.did, rkey: source.rkey }),
		});
		const sourcePortal = mapping
			? this.portalsFor(source.space).find((held) => held.registration === portal.registration)
			: undefined;
		return {
			markdown: colibriToMarkdown(forward.text, forward.facets ?? [], this.referrer(portal)),
			...(mapping && sourcePortal
				? { source: { ...this.location(sourcePortal), id: mapping.remoteId } }
				: {}),
			attachments: outboundAttachments(forward.attachments),
		};
	}

	private async outboundHide(portal: Portal, subject: { did: string; rkey: string }) {
		const registration = this.mappingRegistration(portal);
		const key = colibriRecordKey({ channel: portal.channel, ...subject });
		const mapping = await this.options.store.byColibri({
			registration,
			kind: "message",
			rkey: key,
		});
		if (!mapping) return;
		const connector = this.options.connector;
		const target = { ...this.location(portal), id: mapping.remoteId };
		if (mapping.origin === "colibri") {
			if (!canDelete(connector)) return;
			await connector.deleteMessage(target);
		} else {
			if (!portal.mirrorModeration || !canModerate(connector)) return;
			await connector.removeMessage(target);
		}
		await this.options.store.remove({ registration, kind: "message", rkey: key });
	}

	private async outboundThread(parent: Portal, thread: ThreadView): Promise<void> {
		const connector = this.options.connector;
		if (!canThread(connector)) return;
		const registration = this.mappingRegistration(parent);
		const mapping = await this.options.store.byColibri({
			registration,
			kind: "thread",
			rkey: thread.space,
		});
		if (mapping) {
			await connector.renameThread({
				...this.location(parent),
				remoteThread: mapping.remoteId,
				id: mapping.remoteId,
				name: thread.name,
			});
			return;
		}
		if (thread.private) return;

		const anchor =
			thread.anchor && thread.anchor.space === parent.channel
				? await this.options.store.byColibri({
						registration,
						kind: "message",
						rkey: colibriRecordKey({
							channel: parent.channel,
							did: thread.anchor.did,
							rkey: thread.anchor.rkey,
						}),
					})
				: null;
		const id = await connector.createThread({
			...this.location(parent),
			name: thread.name,
			...(anchor ? { anchor: anchor.remoteId } : {}),
		});
		await this.options.store.put({
			registration,
			channel: parent.channel,
			kind: "thread",
			remoteId: id,
			rkey: thread.space,
			origin: "colibri",
		});
		const portal = this.addThread(parent, thread.space, id);
		const earlier = await this.options.client
			.listMessages(thread.space, { reverse: true })
			.then((page) => page.messages)
			.catch((error) => {
				this.log.warn(
					{ thread: thread.space, error: String(error) },
					"bridge.thread.backlogFailed",
				);
				return [];
			});
		for (const message of earlier) await this.outboundMessage(portal, message);
	}

	private async outboundThreadDelete(space: string, portal: Portal): Promise<void> {
		const registration = this.mappingRegistration(portal);
		const mapping = await this.options.store.byColibri({
			registration,
			kind: "thread",
			rkey: space,
		});
		if (!mapping) return;
		if (canThread(this.options.connector)) {
			await this.options.connector.archiveThread({
				...this.location(portal),
				id: mapping.remoteId,
			});
		}
		await this.options.store.remove({ registration, kind: "thread", rkey: space });
		this.dropThread(space, portal);
	}

	private async outboundReaction(portal: Portal, frame: ServerFrame): Promise<void> {
		const connector = this.options.connector;
		if (!canReact(connector)) return;
		const actor = frame.actor as string;
		const bridged = frame.bridged as { registration?: string; remoteId?: string } | undefined;
		if (this.isOwnEcho(portal, { did: actor, bridgeRegistration: bridged?.registration })) return;

		const target = frame.target as { did: string; rkey: string };
		const emoji = frame.emoji as string;
		const registration = this.mappingRegistration(portal);
		const message = await this.options.store.byColibri({
			registration,
			kind: "message",
			rkey: colibriRecordKey({ channel: portal.channel, ...target }),
		});
		if (!message) return;

		const reactionKey = `${registration} ${message.remoteId} ${emoji}`;
		const reactor = bridged?.remoteId ? `${actor} ${bridged.remoteId}` : actor;
		const reaction = {
			...this.location(portal),
			messageId: message.remoteId,
			emoji,
		};
		if (frame.event === "delete") {
			if ((await this.options.store.removeReactor(reactionKey, reactor)) === 0) {
				await connector.removeReaction(reaction);
			}
			return;
		}
		if ((await this.options.store.addReactor(reactionKey, reactor)) === 1) {
			await connector.addReaction(reaction);
		}
	}
}

const colibriAuthor = (profile: MessageView["author"]) => {
	return {
		did: profile.did,
		name: profile.displayName,
		...(profile.handle && profile.handle !== INVALID_HANDLE ? { handle: profile.handle } : {}),
		...(profile.avatar ? { avatarUrl: profile.avatar } : {}),
	};
};

const olderThan = (messages: ReadonlyArray<MessageView>, rkey: string): MessageView[] => {
	const index = messages.findIndex((message) => message.rkey === rkey);

	return index >= 0 ? messages.slice(index + 1) : messages.filter((message) => message.rkey < rkey);
};
