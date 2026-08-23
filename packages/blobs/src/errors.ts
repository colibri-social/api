export class BlobNotFoundError extends Error {
	constructor(message = "blob not found") {
		super(message);
		this.name = "BlobNotFoundError";
	}
}

export type BlobRejectionReason = "mimeNotAllowed" | "cidMismatch" | "tooLarge";

export class BlobRejectedError extends Error {
	readonly reason: BlobRejectionReason;

	constructor(reason: BlobRejectionReason, message?: string) {
		super(message ?? reason);
		this.name = "BlobRejectedError";
		this.reason = reason;
	}
}

export class BlobUpstreamError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BlobUpstreamError";
	}
}
