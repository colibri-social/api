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

export type OutboundAttachment = {
	url: string;
	name?: string;
	mimeType: string;
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
	forward?: OutboundForward;
};

export type OutboundEdit = RemoteLocation & {
	id: string;
	author: ColibriAuthor;
	markdown: string;
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
	pair(remote: { remoteSpace: string; remoteSpaceName: string }): Promise<PairingCode>;
	linkedRooms(remoteSpace: string): LinkedRoom[];
}

export interface NetworkConnector {
	readonly platform: string;
	start(context: BridgeContext): Promise<void>;
	stop(): Promise<void>;
	listRooms(remoteSpace: string): Promise<RemoteRoomInfo[]>;
	sendMessage(message: OutboundMessage): Promise<string>;
}

export interface EditingConnector extends NetworkConnector {
	editMessage(edit: OutboundEdit): Promise<void>;
}

export interface DeletingConnector extends NetworkConnector {
	deleteMessage(target: OutboundDelete): Promise<void>;
}

export interface ReactingConnector extends NetworkConnector {
	addReaction(reaction: OutboundReaction): Promise<void>;
	removeReaction(reaction: OutboundReaction): Promise<void>;
}

export interface ThreadingConnector extends NetworkConnector {
	createThread(thread: OutboundThread): Promise<string>;
	renameThread(thread: OutboundThreadChange): Promise<void>;
	archiveThread(thread: OutboundThreadRef): Promise<void>;
}

export interface ModeratingConnector extends NetworkConnector {
	removeMessage(target: OutboundDelete): Promise<void>;
}

export interface HistoryConnector extends NetworkConnector {
	fetchHistory(request: HistoryRequest): Promise<HistoryMessage[]>;
	listThreads(room: RemoteLocation & { since?: string; until: string }): Promise<HistoryThread[]>;
	roomCreatedAt(room: RemoteLocation): Promise<string>;
}

export const canEdit = (connector: NetworkConnector): connector is EditingConnector =>
	typeof (connector as Partial<EditingConnector>).editMessage === "function";

export const canDelete = (connector: NetworkConnector): connector is DeletingConnector =>
	typeof (connector as Partial<DeletingConnector>).deleteMessage === "function";

export const canReact = (connector: NetworkConnector): connector is ReactingConnector =>
	typeof (connector as Partial<ReactingConnector>).addReaction === "function" &&
	typeof (connector as Partial<ReactingConnector>).removeReaction === "function";

export const canThread = (connector: NetworkConnector): connector is ThreadingConnector =>
	typeof (connector as Partial<ThreadingConnector>).createThread === "function" &&
	typeof (connector as Partial<ThreadingConnector>).renameThread === "function" &&
	typeof (connector as Partial<ThreadingConnector>).archiveThread === "function";

export const canModerate = (connector: NetworkConnector): connector is ModeratingConnector =>
	typeof (connector as Partial<ModeratingConnector>).removeMessage === "function";

export const canImportHistory = (connector: NetworkConnector): connector is HistoryConnector =>
	typeof (connector as Partial<HistoryConnector>).fetchHistory === "function" &&
	typeof (connector as Partial<HistoryConnector>).listThreads === "function" &&
	typeof (connector as Partial<HistoryConnector>).roomCreatedAt === "function";
