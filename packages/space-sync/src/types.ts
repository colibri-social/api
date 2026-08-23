export type SyncSpace = {
	uri: string;
	authority: string;
};

export type RepoSyncState = "pending" | "active" | "diverged" | "error" | "gone";

export type RepoCursor = {
	space: string;
	author: string;
	appliedRev: string | null;
	setHashBase64: string | null;
	state: RepoSyncState;
	consecutiveFailures: number;
	retryAfter: Date | null;
};

export type RecordWrite = {
	collection: string;
	rkey: string;
	cid: string;
	value: Record<string, unknown>;
};

export type RecordDelete = {
	collection: string;
	rkey: string;
};

export type RepoChange = {
	space: string;
	author: string;
	puts: RecordWrite[];
	deletes: RecordDelete[];
};

export type CommittedCursor = Pick<
	RepoCursor,
	"space" | "author" | "appliedRev" | "setHashBase64" | "state"
>;

export type SyncStore = {
	listSpaces(): Promise<SyncSpace[]>;
	listCursors(space: string): Promise<RepoCursor[]>;
	loadCursor(space: string, author: string): Promise<RepoCursor | null>;
	saveCursor(cursor: RepoCursor): Promise<void>;
	commit(change: RepoChange, cursor: CommittedCursor): Promise<void>;
	replace(change: Omit<RepoChange, "deletes">, cursor: CommittedCursor): Promise<void>;
	dropRepo(space: string, author: string): Promise<void>;
	dropSpace(space: string): Promise<void>;
};

export type RepoHostResolver = {
	hostFor(did: string): Promise<string>;
};

export type SigningKeyResolver = {
	signingKeyFor(did: string): Promise<string>;
};

export type SyncEvents = {
	changed: (change: RepoChange) => void;
	repoGone: (space: string, author: string) => void;
	spaceDeleted: (space: string) => void;
	diverged: (space: string, author: string) => void;
	failed: (space: string, author: string, error: unknown) => void;
};
