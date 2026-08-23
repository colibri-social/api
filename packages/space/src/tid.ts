import { TID } from "@atproto/common";

export const nextTid = (): string => TID.nextStr();

export const isTid = (value: string): boolean => TID.is(value);
