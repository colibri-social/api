import type { ProjectionDeps, RecordRef } from "./context.js";
import { spaceContextFor } from "./context.js";
import * as channel from "./mappers/channel.js";
import * as community from "./mappers/community.js";
import * as personal from "./mappers/personal.js";
import { type ErasedProjector, erase, refusalFor } from "./projector.js";

const ALL: ErasedProjector[] = [
	erase(community.communityProfile),
	erase(community.communitySettings),
	erase(community.category),
	erase(community.role),
	erase(community.member),
	erase(community.channel),
	erase(community.moderation),
	erase(channel.message),
	erase(channel.reaction),
	erase(channel.label),
	erase(personal.mute),
	erase(personal.settings),
	erase(personal.readCursors),
];

const BY_COLLECTION = new Map(ALL.map((projector) => [projector.collection, projector]));

export const projectedCollections = (): string[] => [...BY_COLLECTION.keys()];

export type SpaceChange = {
	space: string;
	author: string;
	puts: Array<{ collection: string; rkey: string; cid: string; value: Record<string, unknown> }>;
	deletes: Array<{ collection: string; rkey: string }>;
};

export const applyChange = async (deps: ProjectionDeps, change: SpaceChange): Promise<void> => {
	const space = spaceContextFor(change.space);
	if (!space) return;

	for (const entry of change.deletes) {
		const projector = BY_COLLECTION.get(entry.collection);
		if (!projector) continue;
		const ref: RecordRef = { space, author: change.author, ...entry, cid: "" };
		const refusal = refusalFor(projector, ref);
		if (refusal) {
			deps.onSkipped?.(ref, refusal);
			continue;
		}
		await projector.remove(deps, ref);
	}

	for (const entry of change.puts) {
		const projector = BY_COLLECTION.get(entry.collection);
		if (!projector) continue;
		const ref: RecordRef = { space, author: change.author, ...entry };
		const refusal = refusalFor(projector, ref);
		if (refusal) {
			deps.onSkipped?.(ref, refusal);
			continue;
		}
		const outcome = await projector.apply(deps, ref, entry.value);
		if (!outcome.applied) deps.onSkipped?.(ref, outcome.reason);
	}
};
