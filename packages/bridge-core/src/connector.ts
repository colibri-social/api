import type { ChannelView } from "./client.js";

export type RemoteRoomInfo = {
	id: string;
	name: string;
	kind?: "text" | "voice" | "announcement" | "forum" | "other";
	parent?: string;
};

export type RemoteAuthor = {
	id: string;
	name: string;
	avatarUrl?: string;
};

export type RemoteAttachment = {
	url: string;
	name?: string;
	size?: number;
	alt?: string;
	spoiler?: boolean;
};

export type RemoteLocation = {
	remoteSpace: string;
	remoteRoom: string;
	remoteThread?: string;
};

export type RemoteThread = {
	id: string;
	name: string;
	anchor?: string;
};

export type RemoteForward = {
	remoteMessage?: string;
	markdown: string;
	attachments?: RemoteAttachment[];
	createdAt?: string;
};

export type InboundEvent =
	| (RemoteLocation & {
			type: "message";
			id: string;
			author: RemoteAuthor;
			markdown: string;
			replyTo?: string;
			attachments?: RemoteAttachment[];
			forward?: RemoteForward;
			thread?: RemoteThread;
			createdAt?: string;
	  })
	| (RemoteLocation & { type: "messageEdit"; id: string; markdown: string })
	| (RemoteLocation & { type: "messageDelete"; id: string })
	| (RemoteLocation & {
			type: "reactionAdd";
			messageId: string;
			author: RemoteAuthor;
			emoji: string;
	  })
	| (RemoteLocation & {
			type: "reactionRemove";
			messageId: string;
			authorId: string;
			emoji: string;
	  })
	| (RemoteLocation & RemoteThread & { type: "threadCreate"; author: RemoteAuthor })
	| (RemoteLocation & { type: "threadUpdate"; id: string; name: string })
	| (RemoteLocation & { type: "threadDelete"; id: string })
	| { type: "roomsChanged"; remoteSpace: string }
	| { type: "spaceLeft"; remoteSpace: string };

export type HistoryMessage = Omit<
	Extract<InboundEvent, { type: "message" }>,
	"type" | "thread" | "createdAt"
> & { createdAt: string };

export type HistoryRequest = RemoteLocation & {
	since?: string;
	until: string;
	after?: string;
};

export type HistoryThread = RemoteThread & {
	author: RemoteAuthor;
	createdAt: string;
};

export type ColibriAuthor = {
	did: string;
	name: string;
	handle?: string;
	avatarUrl?: string;
};

export type MessageRef = {
	did: string;
	rkey: string;
};

export type OpenChannelRef = {
	community: string;
	registration: string;
	channel: string;
	thread?: string;
};

export type OpenChannelInfo = OpenChannelRef & MessageRef;

export type MemberRole = {
	rkey: string;
	name: string;
	position: number;
};

export type MemberStanding = {
	did: string;
	member: boolean;
	owner: boolean;
	roles: MemberRole[];
	permissions: string[];
};

export type OpenChannelAuthor = ColibriAuthor & {
	standing: MemberStanding;
};

export type OpenChannelForward = {
	markdown: string;
	attachments: OutboundAttachment[];
	source?: { channel: string } & MessageRef;
};

export type OpenChannelContent = {
	author: OpenChannelAuthor;
	markdown: string;
	replyTo?: MessageRef;
	attachments: OutboundAttachment[];
	embeds: OutboundEmbed[];
	forward?: OpenChannelForward;
	createdAt: string;
	updatedAt?: string;
};

export type OpenChannelMessage = OpenChannelContent & OpenChannelInfo;

export type OpenChannelEdit = OpenChannelContent & OpenChannelInfo;

export type OpenChannelDelete = OpenChannelInfo;

export type OpenChannelReaction = OpenChannelInfo & {
	emoji: string;
	actor: string;
	customEmoji?: { uri: string };
};

export type OpenChannelThread = OpenChannelRef & {
	thread: string;
	name: string;
	anchor?: MessageRef;
};

export type OpenChannelsChange = {
	community: string;
	registration: string;
	kind: "installed" | "updated" | "removed";
	channels: string[];
	added: string[];
	removed: string[];
};

export type OpenInboundEvent =
	| (OpenChannelRef & {
			type: "message";
			author: RemoteAuthor;
			markdown: string;
			replyTo?: MessageRef;
			attachments?: RemoteAttachment[];
			forward?: OpenChannelForwardInput;
	  })
	| (OpenChannelRef & { type: "messageEdit"; rkey: string; markdown: string })
	| (OpenChannelRef & { type: "messageDelete"; rkey: string })
	| (OpenChannelRef & MessageRef & { type: "messageRemove"; reason?: string })
	| (OpenChannelRef & MessageRef & { type: "reactionAdd"; author: RemoteAuthor; emoji: string })
	| (OpenChannelRef & { type: "reactionRemove"; rkey: string })
	| (OpenChannelRef & {
			type: "threadCreate";
			name: string;
			author: RemoteAuthor;
			anchor?: MessageRef;
	  })
	| (OpenChannelRef & { type: "threadUpdate"; thread: string; name: string })
	| (OpenChannelRef & { type: "threadDelete"; thread: string });

export type OpenChannelForwardInput = {
	markdown: string;
	attachments?: RemoteAttachment[];
	createdAt?: string;
	source?: { channel: string } & MessageRef;
};

export type OpenEmitResult = {
	rkey?: string;
	thread?: string;
	dropped: DroppedAttachment[];
};

export type DroppedAttachment = RemoteAttachment & {
	reason: "tooLarge" | "fetchFailed" | "uploadFailed";
};

export type OpenHistoryRequest = OpenChannelRef & {
	before?: string;
	limit?: number;
};

export type OutboundAttachment = {
	url: string;
	name?: string;
	mimeType: string;
	size?: number;
	alt?: string;
	spoiler?: boolean;
	width?: number;
	height?: number;
};

export type OutboundEmbed = {
	url: string;
	title?: string;
	description?: string;
	siteName?: string;
	imageUrl?: string;
	themeColor?: string;
};

export type OutboundForward = {
	markdown: string;
	source?: RemoteLocation & { id: string };
	attachments: OutboundAttachment[];
};

export type OutboundMessage = RemoteLocation & {
	author: ColibriAuthor;
	markdown: string;
	replyTo?: string;
	attachments: OutboundAttachment[];
	embeds: OutboundEmbed[];
	forward?: OutboundForward;
};

export type OutboundEdit = RemoteLocation & {
	id: string;
	author: ColibriAuthor;
	markdown: string;
	embeds: OutboundEmbed[];
};

export type OutboundDelete = RemoteLocation & { id: string };

export type OutboundReaction = RemoteLocation & {
	messageId: string;
	emoji: string;
};

export type OutboundThread = RemoteLocation & {
	name: string;
	anchor?: string;
};

export type OutboundThreadChange = RemoteLocation & {
	id: string;
	name: string;
};

export type OutboundThreadRef = RemoteLocation & { id: string };

export type PairingCode = {
	code: string;
	expiresAt: string;
};

export type BridgeConnection = {
	community: string;
	communityName?: string;
	registration: string;
};

export type LinkedRoom = {
	community: string;
	registration: string;
	channel: string;
	remoteRoom: string;
	remoteName: string;
};

export type BridgeLogger = {
	debug(detail: Record<string, unknown>, message: string): void;
	info(detail: Record<string, unknown>, message: string): void;
	warn(detail: Record<string, unknown>, message: string): void;
	error(detail: Record<string, unknown>, message: string): void;
};

export interface BridgeContext {
	readonly did: string;
	readonly log: BridgeLogger;
	emit(event: InboundEvent): void;
	openEmit(event: OpenInboundEvent): Promise<OpenEmitResult>;
	pair(remote: { remoteSpace: string; remoteSpaceName: string }): Promise<PairingCode>;
	linkedRooms(remoteSpace: string): LinkedRoom[];
	connections(remoteSpace: string): BridgeConnection[];
	channels(community: string, registration: string): Promise<ChannelView[]>;
	openChannels(community: string, registration: string): string[];
	message(ref: OpenChannelInfo): Promise<OpenChannelMessage | null>;
	history(request: OpenHistoryRequest): Promise<OpenChannelMessage[]>;
	member(ref: Omit<OpenChannelRef, "thread"> & { did: string }): Promise<MemberStanding>;
	disconnect(remoteSpace: string, community?: string): Promise<number>;
}

export interface Connector {
	readonly platform: string;
	start(context: BridgeContext): Promise<void>;
	stop(): Promise<void>;
}

export interface RelayConnector extends Connector {
	listRooms(remoteSpace: string): Promise<RemoteRoomInfo[]>;
	sendMessage(message: OutboundMessage): Promise<string>;
}

export interface EditingConnector extends RelayConnector {
	editMessage(edit: OutboundEdit): Promise<void>;
}

export interface DeletingConnector extends RelayConnector {
	deleteMessage(target: OutboundDelete): Promise<void>;
}

export interface ReactingConnector extends RelayConnector {
	addReaction(reaction: OutboundReaction): Promise<void>;
	removeReaction(reaction: OutboundReaction): Promise<void>;
}

export interface ThreadingConnector extends RelayConnector {
	createThread(thread: OutboundThread): Promise<string>;
	renameThread(thread: OutboundThreadChange): Promise<void>;
	archiveThread(thread: OutboundThreadRef): Promise<void>;
}

export interface ModeratingConnector extends RelayConnector {
	removeMessage(target: OutboundDelete): Promise<void>;
}

export interface OpenChannelConnector extends Connector {
	openMessage(message: OpenChannelMessage): Promise<void>;
}

export interface OpenEditingConnector extends OpenChannelConnector {
	openEditMessage(edit: OpenChannelEdit): Promise<void>;
}

export interface OpenDeletingConnector extends OpenChannelConnector {
	openDeleteMessage(target: OpenChannelDelete): Promise<void>;
}

export interface OpenModeratingConnector extends OpenChannelConnector {
	openRemoveMessage(target: OpenChannelDelete): Promise<void>;
}

export interface OpenReactingConnector extends OpenChannelConnector {
	openAddReaction(reaction: OpenChannelReaction): Promise<void>;
	openRemoveReaction(reaction: OpenChannelReaction): Promise<void>;
}

export interface OpenThreadingConnector extends OpenChannelConnector {
	openCreateThread(thread: OpenChannelThread): Promise<void>;
	openUpdateThread(thread: OpenChannelThread): Promise<void>;
	openDeleteThread(thread: Omit<OpenChannelThread, "name" | "anchor">): Promise<void>;
}

export interface OpenLifecycleConnector extends OpenChannelConnector {
	openChannelsChanged(change: OpenChannelsChange): Promise<void>;
}

export interface HistoryConnector extends RelayConnector {
	fetchHistory(request: HistoryRequest): Promise<HistoryMessage[]>;
	listThreads(room: RemoteLocation & { since?: string; until: string }): Promise<HistoryThread[]>;
	roomCreatedAt(room: RemoteLocation): Promise<string>;
}

const hasMethods = (connector: Connector, ...names: string[]) => {
	return names.every(
		(name) => typeof (connector as unknown as Record<string, unknown>)[name] === "function",
	);
};

export const canRelay = (connector: Connector): connector is RelayConnector =>
	hasMethods(connector, "listRooms", "sendMessage");

export const canEdit = (connector: Connector): connector is EditingConnector =>
	canRelay(connector) && hasMethods(connector, "editMessage");

export const canOpen = (connector: Connector): connector is OpenChannelConnector =>
	hasMethods(connector, "openMessage");

export const canOpenEdit = (connector: Connector): connector is OpenEditingConnector =>
	canOpen(connector) && hasMethods(connector, "openEditMessage");

export const canOpenDelete = (connector: Connector): connector is OpenDeletingConnector =>
	canOpen(connector) && hasMethods(connector, "openDeleteMessage");

export const canOpenModerate = (connector: Connector): connector is OpenModeratingConnector =>
	canOpen(connector) && hasMethods(connector, "openRemoveMessage");

export const canOpenReact = (connector: Connector): connector is OpenReactingConnector =>
	canOpen(connector) && hasMethods(connector, "openAddReaction", "openRemoveReaction");

export const canOpenThread = (connector: Connector): connector is OpenThreadingConnector =>
	canOpen(connector) &&
	hasMethods(connector, "openCreateThread", "openUpdateThread", "openDeleteThread");

export const canOpenLifecycle = (connector: Connector): connector is OpenLifecycleConnector =>
	canOpen(connector) && hasMethods(connector, "openChannelsChanged");

export const canDelete = (connector: Connector): connector is DeletingConnector =>
	canRelay(connector) && hasMethods(connector, "deleteMessage");

export const canReact = (connector: Connector): connector is ReactingConnector =>
	canRelay(connector) && hasMethods(connector, "addReaction", "removeReaction");

export const canThread = (connector: Connector): connector is ThreadingConnector =>
	canRelay(connector) && hasMethods(connector, "createThread", "renameThread", "archiveThread");

export const canModerate = (connector: Connector): connector is ModeratingConnector =>
	canRelay(connector) && hasMethods(connector, "removeMessage");

export const canImportHistory = (connector: Connector): connector is HistoryConnector =>
	canRelay(connector) && hasMethods(connector, "fetchHistory", "listThreads", "roomCreatedAt");
