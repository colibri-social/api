import type { social } from "@colibri-social/lexicons";
import type { ServiceAuthSigner } from "./auth.js";

export type RegistrationView = social.colibri.beta.bridge.defs.RegistrationView;
export type RemoteRoom = social.colibri.beta.bridge.defs.RemoteRoom;
export type MessageView = social.colibri.beta.channel.defs.MessageView;
export type ThreadView = social.colibri.beta.thread.defs.ThreadView;
export type Facet = social.colibri.beta.richtext.facet.Main;

export type BlobRef = {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
};

export type RemoteAuthorInput = {
	id: string;
	name: string;
	avatar?: BlobRef;
};

export type AttachmentInput = {
	blob: BlobRef;
	name?: string;
};

export type RegistrationRef = {
	community: string;
	registration: string;
};

export type PostMessageInput = RegistrationRef & {
	channel: string;
	author: RemoteAuthorInput;
	text: string;
	facets?: Facet[];
	parent?: { did: string; rkey: string };
	attachments?: AttachmentInput[];
	forward?: ForwardInput;
	remoteMessage?: string;
	createdAt?: string;
};

export type ForwardInput = {
	source: { space: string; did: string; rkey: string };
	createdAt: string;
	text: string;
	facets?: Facet[];
	attachments?: AttachmentInput[];
};

export type CreateThreadInput = RegistrationRef & {
	channel: string;
	name: string;
	author: RemoteAuthorInput;
	anchor?: { did: string; rkey: string };
	remoteThread?: string;
	createdAt?: string;
};

export type ThreadInput = RegistrationRef & { thread: string };

export type ImportedMessageInput = {
	author: RemoteAuthorInput;
	text: string;
	facets?: Facet[];
	parent?: { did: string; rkey: string };
	attachments?: AttachmentInput[];
	forward?: ForwardInput;
	remoteMessage: string;
	createdAt: string;
};

export type ImportMessagesInput = RegistrationRef & {
	channel: string;
	messages: ImportedMessageInput[];
};

export type BackfillState = "running" | "done" | "failed";

export type ReportBackfillInput = RegistrationRef & {
	channel: string;
	requestedAt: string;
	state: BackfillState;
	imported: number;
	from: string;
	until: string;
	reached?: string;
};

export type HideMessageInput = RegistrationRef & {
	channel: string;
	subject: { did: string; rkey: string };
	reason?: string;
};

export type EditMessageInput = RegistrationRef & {
	channel: string;
	rkey: string;
	text: string;
	facets?: Facet[];
};

export type RecordInput = RegistrationRef & {
	channel: string;
	rkey: string;
};

export type AddReactionInput = RegistrationRef & {
	channel: string;
	author: RemoteAuthorInput;
	target: { did: string; rkey: string };
	emoji: string;
};

export class ColibriRequestError extends Error {
	constructor(
		readonly status: number,
		readonly error: string,
		message: string,
		readonly retryAfterSeconds: number | null,
	) {
		super(message);
		this.name = "ColibriRequestError";
	}
}

export type ColibriClientOptions = {
	appviewUrl: string;
	appviewDid: string;
	signer: ServiceAuthSigner;
	fetch?: typeof fetch;
};

export const resolveAppviewDid = async (
	appviewUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<string> => {
	const response = await fetcher(new URL("/.well-known/did.json", appviewUrl));
	if (!response.ok)
		throw new Error(`could not read the AppView's DID document (${response.status})`);
	const document = (await response.json()) as { id?: unknown };
	if (typeof document.id !== "string") throw new Error("the AppView's DID document has no id");
	return document.id;
};

export class ColibriClient {
	private readonly fetcher: typeof fetch;

	constructor(private readonly options: ColibriClientOptions) {
		this.fetcher = options.fetch ?? fetch;
	}

	get appviewUrl(): string {
		return this.options.appviewUrl;
	}

	get appviewDid(): string {
		return this.options.appviewDid;
	}

	get did(): string {
		return this.options.signer.did;
	}

	token(lxm: string): Promise<string> {
		return this.options.signer.token(this.options.appviewDid, lxm);
	}

	private url(nsid: string, params?: Record<string, string | number | boolean | undefined>): URL {
		const url = new URL(`/xrpc/${nsid}`, this.options.appviewUrl);
		for (const [key, value] of Object.entries(params ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url;
	}

	private async send<T>(nsid: string, url: URL, init: RequestInit): Promise<T> {
		const response = await this.fetcher(url, {
			...init,
			headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.token(nsid)}` },
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			const retryAfter = Number(response.headers.get("retry-after"));
			throw new ColibriRequestError(
				response.status,
				typeof body.error === "string" ? body.error : "RequestFailed",
				typeof body.message === "string" ? body.message : `${nsid} failed with ${response.status}`,
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
			);
		}
		return body as T;
	}

	query<T>(
		nsid: string,
		params?: Record<string, string | number | boolean | undefined>,
	): Promise<T> {
		return this.send<T>(nsid, this.url(nsid, params), { method: "GET" });
	}

	procedure<T>(nsid: string, input: unknown): Promise<T> {
		return this.send<T>(nsid, this.url(nsid), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}

	async getConfiguration(): Promise<RegistrationView[]> {
		const { registrations } = await this.query<{ registrations: RegistrationView[] }>(
			"social.colibri.beta.bridge.getConfiguration",
		);
		return registrations;
	}

	createPairing(input: {
		platform: string;
		remoteSpace: string;
		remoteSpaceName: string;
	}): Promise<{ code: string; expiresAt: string }> {
		return this.procedure("social.colibri.beta.bridge.createPairing", input);
	}

	async putRemoteRooms(ref: RegistrationRef, rooms: RemoteRoom[]): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.putRemoteRooms", { ...ref, rooms });
	}

	async uploadBlob(ref: RegistrationRef, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
		const { blob } = await this.send<{ blob: BlobRef }>(
			"social.colibri.beta.bridge.uploadBlob",
			this.url("social.colibri.beta.bridge.uploadBlob", { ...ref }),
			{ method: "POST", headers: { "content-type": mimeType }, body: bytes },
		);
		return blob;
	}

	postMessage(input: PostMessageInput): Promise<{ rkey: string }> {
		return this.procedure("social.colibri.beta.bridge.postMessage", input);
	}

	async editMessage(input: EditMessageInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.editMessage", input);
	}

	async deleteMessage(input: RecordInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.deleteMessage", input);
	}

	addReaction(input: AddReactionInput): Promise<{ rkey: string }> {
		return this.procedure("social.colibri.beta.bridge.addReaction", input);
	}

	async removeReaction(input: RecordInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.removeReaction", input);
	}

	createThread(input: CreateThreadInput): Promise<{ thread: string }> {
		return this.procedure("social.colibri.beta.bridge.createThread", input);
	}

	async updateThread(input: ThreadInput & { name: string }): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.updateThread", input);
	}

	async deleteThread(input: ThreadInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.deleteThread", input);
	}

	async hideMessage(input: HideMessageInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.hideMessage", input);
	}

	async importMessages(
		input: ImportMessagesInput,
	): Promise<{ remoteMessage: string; rkey: string }[]> {
		const { results } = await this.procedure<{
			results: { remoteMessage: string; rkey: string }[];
		}>("social.colibri.beta.bridge.importMessages", input);
		return results;
	}

	async reportBackfill(input: ReportBackfillInput): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.reportBackfill", input);
	}

	async leave(ref: RegistrationRef): Promise<void> {
		await this.procedure("social.colibri.beta.bridge.leave", ref);
	}

	async replaceAvatar(
		ref: RegistrationRef & { remoteId: string; avatar?: BlobRef },
	): Promise<number> {
		const { updated } = await this.procedure<{ updated: number }>(
			"social.colibri.beta.bridge.replaceAvatar",
			ref,
		);
		return updated;
	}

	async listMessages(channel: string, limit = 50): Promise<MessageView[]> {
		const { messages } = await this.query<{ messages: MessageView[] }>(
			"social.colibri.beta.channel.listMessages",
			{ channel, limit, reverse: true },
		);
		return messages;
	}

	async fetchBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
		const response = await this.fetcher(url);
		if (!response.ok) throw new Error(`could not fetch ${url} (${response.status})`);
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			mimeType: response.headers.get("content-type") ?? "application/octet-stream",
		};
	}
}
