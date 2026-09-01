import type { Queryable, Schema } from "@colibri-social/appview-db";
import { COLLECTIONS, LABEL_VALUES } from "@colibri-social/lexicons";
import { and, asc, eq, inArray } from "drizzle-orm";

export type SuppressionDeps = {
	db: Queryable;
	tables: Schema;
};

export type MessageRef = {
	author: string;
	rkey: string;
};

export type CurrentLabel = {
	src: string;
	val: string;
	scope: string[] | null;
	reason: string | null;
	createdAt: string;
};

export const messageRefKey = (author: string, rkey: string): string => `${author} ${rkey}`;

export const honoredLabelers = async (
	deps: SuppressionDeps,
	community: string,
): Promise<string[]> => {
	const [row] = await deps.db
		.select({ labelers: deps.tables.communities.labelers })
		.from(deps.tables.communities)
		.where(eq(deps.tables.communities.did, community))
		.limit(1);
	return [...new Set([...(row?.labelers ?? []), community])];
};

export const messageLabels = async (
	deps: SuppressionDeps,
	space: string,
	sources: readonly string[],
	subjects: readonly MessageRef[],
): Promise<Map<string, CurrentLabel[]>> => {
	const bySubject = new Map<string, CurrentLabel[]>();
	if (subjects.length === 0 || sources.length === 0) return bySubject;

	const dids = [...new Set(subjects.map((subject) => subject.author))];
	const table = deps.tables.labels;

	const rows = await deps.db
		.select()
		.from(table)
		.where(
			and(
				eq(table.space, space),
				eq(table.subjectCollection, COLLECTIONS.message),
				inArray(table.subjectDid, dids),
				inArray(table.src, [...sources]),
			),
		)
		.orderBy(asc(table.rkey));

	const wanted = new Set(subjects.map((subject) => messageRefKey(subject.author, subject.rkey)));
	const latest = new Map<string, { subject: string; row: (typeof rows)[number] }>();
	for (const row of rows) {
		const subject = messageRefKey(row.subjectDid, row.subjectRkey);
		if (!wanted.has(subject)) continue;
		latest.set(`${subject} ${row.src} ${row.val}`, { subject, row });
	}

	for (const { subject, row } of latest.values()) {
		if (row.negated) continue;
		const list = bySubject.get(subject) ?? [];
		list.push({
			src: row.src,
			val: row.val,
			scope: row.scope ?? null,
			reason: row.reason ?? null,
			createdAt: row.createdAt,
		});
		bySubject.set(subject, list);
	}
	return bySubject;
};

export const hiddenFrom = (labels: Map<string, CurrentLabel[]>): Set<string> => {
	const hidden = new Set<string>();
	for (const [subject, list] of labels) {
		if (list.some((label) => label.val === LABEL_VALUES.hidden)) hidden.add(subject);
	}
	return hidden;
};

export const hiddenMessageKeys = async (
	deps: SuppressionDeps,
	space: string,
	sources: readonly string[],
	subjects: readonly MessageRef[],
): Promise<Set<string>> => hiddenFrom(await messageLabels(deps, space, sources, subjects));

export const isMessageHidden = async (
	deps: SuppressionDeps,
	space: string,
	community: string,
	subject: MessageRef,
): Promise<boolean> => {
	const sources = await honoredLabelers(deps, community);
	const hidden = await hiddenMessageKeys(deps, space, sources, [subject]);
	return hidden.has(messageRefKey(subject.author, subject.rkey));
};

export type MovedMessage = {
	source: string;
	author: string;
	rkey: string;
	batch: string;
	movedAt: string;
	reason: string | null;
};

type LabelRow = Schema["labels"]["$inferSelect"];

const latestPerSubject = (rows: readonly LabelRow[]): Map<string, LabelRow> => {
	const latest = new Map<string, LabelRow>();
	for (const row of rows) {
		latest.set(`${row.space} ${row.subjectDid} ${row.subjectRkey} ${row.src}`, row);
	}
	return latest;
};

const movedLabelsIn = async (
	deps: SuppressionDeps,
	space: string,
	sources: readonly string[],
): Promise<LabelRow[]> => {
	const table = deps.tables.labels;
	return deps.db
		.select()
		.from(table)
		.where(
			and(
				eq(table.space, space),
				eq(table.val, LABEL_VALUES.moved),
				eq(table.subjectCollection, COLLECTIONS.message),
				inArray(table.src, [...sources]),
			),
		)
		.orderBy(asc(table.rkey));
};

export const movedOutOf = async (
	deps: SuppressionDeps,
	space: string,
	sources: readonly string[],
): Promise<Set<string>> => {
	const gone = new Set<string>();
	if (sources.length === 0) return gone;
	for (const row of latestPerSubject(await movedLabelsIn(deps, space, sources)).values()) {
		if (row.negated || !row.destination) continue;
		gone.add(messageRefKey(row.subjectDid, row.subjectRkey));
	}
	return gone;
};

export const movedInto = async (
	deps: SuppressionDeps,
	destination: string,
	sources: readonly string[],
): Promise<MovedMessage[]> => {
	if (sources.length === 0) return [];
	const table = deps.tables.labels;

	const candidates = await deps.db
		.select({ space: table.space })
		.from(table)
		.where(
			and(
				eq(table.destination, destination),
				eq(table.val, LABEL_VALUES.moved),
				eq(table.subjectCollection, COLLECTIONS.message),
				inArray(table.src, [...sources]),
			),
		);
	const spaces = [...new Set(candidates.map((row) => row.space))];
	if (spaces.length === 0) return [];

	const rows = await deps.db
		.select()
		.from(table)
		.where(
			and(
				inArray(table.space, spaces),
				eq(table.val, LABEL_VALUES.moved),
				eq(table.subjectCollection, COLLECTIONS.message),
				inArray(table.src, [...sources]),
			),
		)
		.orderBy(asc(table.rkey));

	const moved: MovedMessage[] = [];
	for (const row of latestPerSubject(rows).values()) {
		if (row.negated || row.destination !== destination || !row.batch) continue;
		moved.push({
			source: row.space,
			author: row.subjectDid,
			rkey: row.subjectRkey,
			batch: row.batch,
			movedAt: row.createdAt,
			reason: row.reason,
		});
	}
	return moved;
};
