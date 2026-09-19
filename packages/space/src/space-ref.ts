import {
	AtUri,
	type DidString,
	ensureValidDid,
	ensureValidNsid,
	ensureValidRecordKey,
	type NsidString,
	type RecordKeyString,
	SpaceRef,
} from "@atproto/syntax";
import { SpaceRefError } from "./errors.js";

export type SpaceRefString = string;
export type SpaceRecordUri = string;

const asDid = (value: string): DidString => {
	ensureValidDid(value);
	return value as DidString;
};

const asNsid = (value: string): NsidString => {
	ensureValidNsid(value);
	return value as NsidString;
};

const asRecordKey = (value: string): RecordKeyString => {
	ensureValidRecordKey(value);
	return value as RecordKeyString;
};

export type ParsedSpaceRef = {
	authority: string;
	spaceType: string;
	skey: string;
	uri: SpaceRefString;
};

export type ParsedSpaceRecord = ParsedSpaceRef & {
	author: string;
	collection: string;
	rkey: string;
};

export const spaceRef = (authority: string, spaceType: string, skey: string): SpaceRefString =>
	new SpaceRef(asDid(authority), asNsid(spaceType), asRecordKey(skey)).toString();

export const parseSpaceRef = (value: string): ParsedSpaceRef => {
	let parsed: SpaceRef;
	try {
		parsed = SpaceRef.parse(value);
	} catch {
		throw new SpaceRefError(value);
	}
	return {
		authority: parsed.spaceDid,
		spaceType: parsed.spaceType,
		skey: parsed.skey,
		uri: parsed.toString(),
	};
};

export const tryParseSpaceRef = (value: string): ParsedSpaceRef | null => {
	try {
		return parseSpaceRef(value);
	} catch {
		return null;
	}
};

export const spaceRecordUri = (
	space: SpaceRefString,
	author: string,
	collection: string,
	rkey: string,
): SpaceRecordUri => {
	const { authority, spaceType, skey } = parseSpaceRef(space);
	return AtUri.makeSpace(
		asDid(authority),
		asNsid(spaceType),
		asRecordKey(skey),
		asDid(author),
		asNsid(collection),
		asRecordKey(rkey),
	).toString();
};

export const parseSpaceRecordUri = (value: string): ParsedSpaceRecord => {
	let uri: AtUri;
	let ref: SpaceRef;
	try {
		uri = new AtUri(value);
		ref = SpaceRef.for(value);
	} catch {
		throw new SpaceRefError(value);
	}
	if (!uri.authorDid || !uri.collection || !uri.rkey) throw new SpaceRefError(value);
	return {
		authority: ref.spaceDid,
		spaceType: ref.spaceType,
		skey: ref.skey,
		uri: ref.toString(),
		author: uri.authorDid,
		collection: uri.collection,
		rkey: uri.rkey,
	};
};

export const recordPath = (collection: string, rkey: string) => `${collection}/${rkey}`;
