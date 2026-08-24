import { toLexForm } from "@colibri-social/lexicons";
import type { ProjectionDeps, RecordRef, SpaceContext } from "./context.js";

export type Parsed<T> = { success: true; value: T } | { success?: false; message?: string };

export type RecordSchema<T> = {
	$safeParse: (value: unknown) => Parsed<T>;
};

export type Writer = "authority" | "any";

export type Projector<T> = {
	collection: string;
	writer: Writer;
	spaceTypes?: readonly string[];
	schema: RecordSchema<T>;
	rkey?: (ref: RecordRef) => boolean;
	put: (deps: ProjectionDeps, ref: RecordRef, value: T) => Promise<void>;
	remove: (deps: ProjectionDeps, ref: RecordRef) => Promise<void>;
};

export type ApplyOutcome = { applied: true } | { applied: false; reason: string };

export type ErasedProjector = {
	collection: string;
	writer: Writer;
	spaceTypes?: readonly string[];
	rkey?: (ref: RecordRef) => boolean;
	apply: (deps: ProjectionDeps, ref: RecordRef, value: unknown) => Promise<ApplyOutcome>;
	remove: (deps: ProjectionDeps, ref: RecordRef) => Promise<void>;
};

export const erase = <T>(projector: Projector<T>): ErasedProjector => ({
	collection: projector.collection,
	writer: projector.writer,
	spaceTypes: projector.spaceTypes,
	rkey: projector.rkey,
	remove: projector.remove,
	apply: async (deps, ref, value) => {
		const parsed = projector.schema.$safeParse(toLexForm(value));
		if (!parsed.success) {
			return { applied: false, reason: parsed.message ?? "record does not match its lexicon" };
		}
		await projector.put(deps, ref, parsed.value);
		return { applied: true };
	},
});

export const refusalFor = (projector: ErasedProjector, ref: RecordRef): string | null => {
	if (projector.spaceTypes && !projector.spaceTypes.includes(ref.space.spaceType)) {
		return `collection is not expected in a ${ref.space.spaceType} space`;
	}
	if (projector.writer === "authority" && ref.author !== ref.space.authority) {
		return "collection may only be written by the space authority";
	}
	if (projector.rkey && !projector.rkey(ref)) return "record key is not valid for this collection";
	return null;
};

export const communityOf = (space: SpaceContext): string => {
	if (!space.community) throw new Error(`${space.uri} is not a community space`);
	return space.community;
};
