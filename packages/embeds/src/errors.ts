export type EmbedErrorCode = "NotFetchable" | "GifsNotConfigured" | "UpstreamFailure";

export class EmbedError extends Error {
	readonly code: EmbedErrorCode;
	readonly reason: string;

	constructor(code: EmbedErrorCode, reason: string, cause?: unknown) {
		super(reason, cause !== undefined ? { cause } : undefined);
		this.name = "EmbedError";
		this.code = code;
		this.reason = reason;
	}
}

export const isEmbedError = (value: unknown): value is EmbedError => value instanceof EmbedError;

export const notFetchable = (reason: string, cause?: unknown): EmbedError =>
	new EmbedError("NotFetchable", reason, cause);

export const gifsNotConfigured = (
	reason = "this AppView has no GIF provider key configured",
): EmbedError => new EmbedError("GifsNotConfigured", reason);

export const upstreamFailure = (reason: string, cause?: unknown): EmbedError =>
	new EmbedError("UpstreamFailure", reason, cause);
