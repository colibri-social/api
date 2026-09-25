import { createHash } from "node:crypto";
import { TID } from "@atproto/common";

export const nextTid = (): string => TID.nextStr();

export const isTid = (value: string): boolean => TID.is(value);

export const tidAt = (createdAt: string, seed: string): string => {
	const digest = createHash("sha256").update(seed).digest();
	const micros = digest.readUInt16BE(0) % 1000;
	const clockid = digest.readUInt16BE(2) % 1024;
	return TID.fromTime(Date.parse(createdAt) * 1000 + micros, clockid).toString();
};
