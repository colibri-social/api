import { l } from "@atproto/lex";

export class MalformedValueError extends Error {
	constructor(
		readonly expected: string,
		readonly value: string,
	) {
		super(`expected ${expected}, got ${JSON.stringify(value)}`);
		this.name = "MalformedValueError";
	}
}

const narrow =
	<T extends string>(guard: (value: string) => value is T, expected: string) =>
	(value: string): T => {
		if (!guard(value)) throw new MalformedValueError(expected, value);
		return value;
	};

const optional =
	<T extends string>(cast: (value: string) => T) =>
	(value: string | null | undefined): T | undefined =>
		value === null || value === undefined ? undefined : cast(value);

export const asDid = narrow(l.isDidString, "a DID");
export const asHandle = narrow(l.isHandleString, "a handle");
export const asNsid = narrow(l.isNsidString, "an NSID");
export const asRecordKey = narrow(l.isRecordKeyString, "a record key");
export const asTid = narrow(l.isTidString, "a TID");
export const asDatetime = narrow(l.isDatetimeString, "an ISO 8601 datetime");
export const asUri = narrow(l.isUriString, "a URI");
export const asAtUri = narrow(l.isAtUriString, "an AT URI");
export const asSpaceRef = narrow(l.isSpaceRefString, "a space reference");
export const asCid = narrow(l.isCidString, "a CID");

export const asDidOrUndefined = optional(asDid);
export const asHandleOrUndefined = optional(asHandle);
export const asDatetimeOrUndefined = optional(asDatetime);
export const asUriOrUndefined = optional(asUri);
export const asAtUriOrUndefined = optional(asAtUri);
export const asSpaceRefOrUndefined = optional(asSpaceRef);
export const asRecordKeyOrUndefined = optional(asRecordKey);
export const asTidOrUndefined = optional(asTid);
