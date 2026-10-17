export type PushType = "message" | "read" | "delete" | "edit";

export type PushData = {
	type: PushType;
	kind?: string;
	channelUri: string;
	threadUri?: string;
	messageUri?: string;
	through?: string;
	authorName?: string;
	authorAvatarUrl?: string;
	spaceName?: string;
	placeName?: string;
	subtitle?: string;
	body?: string;
	badge: string;
	readUrl?: string;
	readToken?: string;
	channel?: string;
	messageAuthor?: string;
	messageRkey?: string;
	deepLink?: string;
	tag?: string;
	title?: string;
};

export type PushPayload = {
	type: PushType;
	kind?: string;
	title?: string;
	body?: string;
	tag?: string;
	data: PushData;
};

export const isAlertPush = (payload: Pick<PushPayload, "type">): boolean =>
	payload.type === "message";

export const pushDataStrings = (data: PushData): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
};
