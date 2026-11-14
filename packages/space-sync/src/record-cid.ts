import { serializeRecord } from "@atproto/space";
import type { NsidString, RecordKeyString } from "@atproto/syntax";

export const recordCid = async (
	collection: string,
	rkey: string,
	value: Record<string, unknown>,
): Promise<string> => {
	const serialized = await serializeRecord(
		collection as NsidString,
		rkey as RecordKeyString,
		value as Parameters<typeof serializeRecord>[2],
	);

	return serialized.cid.toString();
};
