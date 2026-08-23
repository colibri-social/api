import type { Queryable, Schema } from "@colibri-social/appview-db";
import { communitySpaces } from "@colibri-social/lexicons";
import { applyChange, type ProjectionDeps } from "@colibri-social/projections";
import { nextTid, type PdsClient } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { CommunityCredentials } from "./credentials.js";

export type WriteDeps = {
	credentials: CommunityCredentials;
	mirror?: {
		db: Queryable;
		tables: Schema;
		projections: ProjectionDeps;
	};
};

export type BlobRef = {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
};

export type RecordWrite = {
	space: string;
	collection: string;
	rkey?: string;
	record: Record<string, unknown>;
};

export class CommunityWriter {
	constructor(private readonly deps: WriteDeps) {}

	spaces(community: string) {
		return communitySpaces(community);
	}

	async uploadBlob(community: string, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		const { pds, session } = await this.deps.credentials.connect(community);
		const { blob } = await pds.uploadBlob(session, bytes, mimeType);
		return blob as BlobRef;
	}

	async currentRecord(
		community: string,
		space: string,
		collection: string,
		rkey: string,
	): Promise<Record<string, unknown> | null> {
		const mirror = this.deps.mirror;
		if (!mirror) return null;
		const [row] = await mirror.db
			.select({ value: mirror.tables.records.value })
			.from(mirror.tables.records)
			.where(
				and(
					eq(mirror.tables.records.space, space),
					eq(mirror.tables.records.author, community),
					eq(mirror.tables.records.collection, collection),
					eq(mirror.tables.records.rkey, rkey),
				),
			)
			.limit(1);
		return row?.value ?? null;
	}

	async put(community: string, write: RecordWrite): Promise<{ uri: string; rkey: string }> {
		const { pds, session } = await this.deps.credentials.connect(community);
		const rkey = write.rkey ?? nextTid();
		const result = await pds.putRecord(session, { ...write, rkey });
		await this.mirrorPut(community, { ...write, rkey }, result.cid);
		return { uri: result.uri, rkey };
	}

	async remove(
		community: string,
		params: { space: string; collection: string; rkey: string },
	): Promise<void> {
		const { pds, session } = await this.deps.credentials.connect(community);
		await pds.deleteRecord(session, params);
		await this.mirrorRemove(community, params);
	}

	async createSpaceFor(
		community: string,
		params: Parameters<PdsClient["createSpace"]>[1],
	): Promise<{ uri: string }> {
		const { pds, session } = await this.deps.credentials.connect(community);
		return pds.createSpace(session, params);
	}

	async deleteSpaceFor(community: string, space: string): Promise<void> {
		const { pds, session } = await this.deps.credentials.connect(community);
		await pds.deleteSpace(session, space);
	}

	private async mirrorPut(
		community: string,
		write: RecordWrite & { rkey: string },
		cid: string,
	): Promise<void> {
		const mirror = this.deps.mirror;
		if (!mirror) return;

		const row = {
			space: write.space,
			author: community,
			collection: write.collection,
			rkey: write.rkey,
			cid,
			value: write.record,
			indexedAt: new Date().toISOString(),
		};

		await mirror.db
			.insert(mirror.tables.records)
			.values(row)
			.onConflictDoUpdate({
				target: [
					mirror.tables.records.space,
					mirror.tables.records.author,
					mirror.tables.records.collection,
					mirror.tables.records.rkey,
				],
				set: row,
			});

		await applyChange(mirror.projections, {
			space: write.space,
			author: community,
			puts: [{ collection: write.collection, rkey: write.rkey, cid, value: write.record }],
			deletes: [],
		});
	}

	private async mirrorRemove(
		community: string,
		params: { space: string; collection: string; rkey: string },
	): Promise<void> {
		const mirror = this.deps.mirror;
		if (!mirror) return;

		await mirror.db
			.delete(mirror.tables.records)
			.where(
				and(
					eq(mirror.tables.records.space, params.space),
					eq(mirror.tables.records.author, community),
					eq(mirror.tables.records.collection, params.collection),
					eq(mirror.tables.records.rkey, params.rkey),
				),
			);

		await applyChange(mirror.projections, {
			space: params.space,
			author: community,
			puts: [],
			deletes: [{ collection: params.collection, rkey: params.rkey }],
		});
	}
}
