import { DatabaseSync } from "node:sqlite";
import type { BlobRef } from "./client.js";

export type MappingKind = "message" | "reaction" | "thread";

export type Mapping = {
	registration: string;
	channel: string;
	kind: MappingKind;
	remoteId: string;
	rkey: string;
	origin: "remote" | "colibri";
};

export type MappingKey = Pick<Mapping, "registration" | "kind">;

export type BackfillProgress = {
	state: "running" | "done" | "failed";
	from: string;
	until: string;
	cursor?: string;
	thread?: { id: string; cursor?: string };
	threadsDone: string[];
	imported: number;
	reached?: string;
};

export interface BridgeStore {
	byRemote(key: MappingKey & { remoteId: string }): Promise<Mapping | null>;
	byColibri(key: MappingKey & { rkey: string }): Promise<Mapping | null>;
	list(key: MappingKey): Promise<Mapping[]>;
	put(mapping: Mapping): Promise<void>;
	remove(key: MappingKey & { rkey: string }): Promise<void>;
	avatar(community: string, url: string): Promise<BlobRef | null>;
	putAvatar(community: string, url: string, blob: BlobRef): Promise<void>;
	addReactor(key: string, reactor: string): Promise<number>;
	removeReactor(key: string, reactor: string): Promise<number>;
	backfill(key: string): Promise<BackfillProgress | null>;
	putBackfill(key: string, progress: BackfillProgress): Promise<void>;
	close(): Promise<void>;
}

const mappingKey = (registration: string, kind: string, id: string) =>
	`${registration} ${kind} ${id}`;

export class MemoryBridgeStore implements BridgeStore {
	private readonly remote = new Map<string, Mapping>();
	private readonly colibri = new Map<string, Mapping>();
	private readonly avatars = new Map<string, BlobRef>();
	private readonly reactors = new Map<string, Set<string>>();
	private readonly backfills = new Map<string, BackfillProgress>();

	async byRemote(key: MappingKey & { remoteId: string }): Promise<Mapping | null> {
		return this.remote.get(mappingKey(key.registration, key.kind, key.remoteId)) ?? null;
	}

	async byColibri(key: MappingKey & { rkey: string }): Promise<Mapping | null> {
		return this.colibri.get(mappingKey(key.registration, key.kind, key.rkey)) ?? null;
	}

	async list(key: MappingKey): Promise<Mapping[]> {
		return [...this.colibri.values()].filter(
			(mapping) => mapping.registration === key.registration && mapping.kind === key.kind,
		);
	}

	async put(mapping: Mapping): Promise<void> {
		this.remote.set(mappingKey(mapping.registration, mapping.kind, mapping.remoteId), mapping);
		this.colibri.set(mappingKey(mapping.registration, mapping.kind, mapping.rkey), mapping);
	}

	async remove(key: MappingKey & { rkey: string }): Promise<void> {
		const mapping = await this.byColibri(key);
		if (!mapping) return;
		this.colibri.delete(mappingKey(key.registration, key.kind, key.rkey));
		this.remote.delete(mappingKey(key.registration, key.kind, mapping.remoteId));
	}

	async avatar(community: string, url: string): Promise<BlobRef | null> {
		return this.avatars.get(`${community} ${url}`) ?? null;
	}

	async putAvatar(community: string, url: string, blob: BlobRef): Promise<void> {
		this.avatars.set(`${community} ${url}`, blob);
	}

	async addReactor(key: string, reactor: string): Promise<number> {
		const held = this.reactors.get(key) ?? new Set<string>();
		held.add(reactor);
		this.reactors.set(key, held);
		return held.size;
	}

	async removeReactor(key: string, reactor: string): Promise<number> {
		const held = this.reactors.get(key);
		if (!held) return 0;
		held.delete(reactor);
		if (held.size === 0) this.reactors.delete(key);
		return held.size;
	}

	async backfill(key: string): Promise<BackfillProgress | null> {
		const progress = this.backfills.get(key);
		return progress ? structuredClone(progress) : null;
	}

	async putBackfill(key: string, progress: BackfillProgress): Promise<void> {
		this.backfills.set(key, structuredClone(progress));
	}

	async close(): Promise<void> {}
}

type MappingRow = {
	registration: string;
	channel: string;
	kind: MappingKind;
	remote_id: string;
	rkey: string;
	origin: "remote" | "colibri";
};

const toMapping = (row: MappingRow | undefined): Mapping | null =>
	row
		? {
				registration: row.registration,
				channel: row.channel,
				kind: row.kind,
				remoteId: row.remote_id,
				rkey: row.rkey,
				origin: row.origin,
			}
		: null;

export class SqliteBridgeStore implements BridgeStore {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS mappings (
				registration TEXT NOT NULL,
				channel TEXT NOT NULL,
				kind TEXT NOT NULL,
				remote_id TEXT NOT NULL,
				rkey TEXT NOT NULL,
				origin TEXT NOT NULL,
				PRIMARY KEY (registration, kind, remote_id)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS mappings_rkey_idx ON mappings (registration, kind, rkey);
			CREATE TABLE IF NOT EXISTS avatars (
				community TEXT NOT NULL,
				url TEXT NOT NULL,
				blob TEXT NOT NULL,
				PRIMARY KEY (community, url)
			);
			CREATE TABLE IF NOT EXISTS reactors (
				key TEXT NOT NULL,
				reactor TEXT NOT NULL,
				PRIMARY KEY (key, reactor)
			);
			CREATE TABLE IF NOT EXISTS backfills (
				key TEXT PRIMARY KEY,
				progress TEXT NOT NULL
			);
		`);
	}

	async byRemote(key: MappingKey & { remoteId: string }): Promise<Mapping | null> {
		return toMapping(
			this.db
				.prepare("SELECT * FROM mappings WHERE registration = ? AND kind = ? AND remote_id = ?")
				.get(key.registration, key.kind, key.remoteId) as MappingRow | undefined,
		);
	}

	async byColibri(key: MappingKey & { rkey: string }): Promise<Mapping | null> {
		return toMapping(
			this.db
				.prepare("SELECT * FROM mappings WHERE registration = ? AND kind = ? AND rkey = ?")
				.get(key.registration, key.kind, key.rkey) as MappingRow | undefined,
		);
	}

	async list(key: MappingKey): Promise<Mapping[]> {
		return (
			this.db
				.prepare("SELECT * FROM mappings WHERE registration = ? AND kind = ?")
				.all(key.registration, key.kind) as MappingRow[]
		).flatMap((row) => toMapping(row) ?? []);
	}

	async put(mapping: Mapping): Promise<void> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO mappings (registration, channel, kind, remote_id, rkey, origin) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				mapping.registration,
				mapping.channel,
				mapping.kind,
				mapping.remoteId,
				mapping.rkey,
				mapping.origin,
			);
	}

	async remove(key: MappingKey & { rkey: string }): Promise<void> {
		this.db
			.prepare("DELETE FROM mappings WHERE registration = ? AND kind = ? AND rkey = ?")
			.run(key.registration, key.kind, key.rkey);
	}

	async avatar(community: string, url: string): Promise<BlobRef | null> {
		const row = this.db
			.prepare("SELECT blob FROM avatars WHERE community = ? AND url = ?")
			.get(community, url) as { blob: string } | undefined;
		return row ? (JSON.parse(row.blob) as BlobRef) : null;
	}

	async putAvatar(community: string, url: string, blob: BlobRef): Promise<void> {
		this.db
			.prepare("INSERT OR REPLACE INTO avatars (community, url, blob) VALUES (?, ?, ?)")
			.run(community, url, JSON.stringify(blob));
	}

	private reactorCount(key: string): number {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM reactors WHERE key = ?").get(key) as
			| { count: number }
			| undefined;
		return Number(row?.count ?? 0);
	}

	async addReactor(key: string, reactor: string): Promise<number> {
		this.db
			.prepare("INSERT OR IGNORE INTO reactors (key, reactor) VALUES (?, ?)")
			.run(key, reactor);
		return this.reactorCount(key);
	}

	async removeReactor(key: string, reactor: string): Promise<number> {
		this.db.prepare("DELETE FROM reactors WHERE key = ? AND reactor = ?").run(key, reactor);
		return this.reactorCount(key);
	}

	async backfill(key: string): Promise<BackfillProgress | null> {
		const row = this.db.prepare("SELECT progress FROM backfills WHERE key = ?").get(key) as
			| { progress: string }
			| undefined;
		return row ? (JSON.parse(row.progress) as BackfillProgress) : null;
	}

	async putBackfill(key: string, progress: BackfillProgress): Promise<void> {
		this.db
			.prepare("INSERT OR REPLACE INTO backfills (key, progress) VALUES (?, ?)")
			.run(key, JSON.stringify(progress));
	}

	async close(): Promise<void> {
		this.db.close();
	}
}
