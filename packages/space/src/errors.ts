export class XrpcError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly method: string,
	) {
		super(message);
		this.name = "XrpcError";
	}

	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isExpiredToken(): boolean {
		return this.code === "ExpiredToken";
	}

	get isSpaceDeleted(): boolean {
		return this.code === "SpaceDeleted";
	}

	get isNotFound(): boolean {
		return this.status === 404 || this.code.endsWith("NotFound");
	}
}

export class SpaceCredentialError extends Error {
	constructor(
		readonly space: string,
		readonly reason:
			| "noDelegationToken"
			| "invalidDelegationToken"
			| "hostUnresolvable"
			| "refused"
			| "spaceDeleted"
			| "upstream",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "SpaceCredentialError";
	}
}

export class SpaceRefError extends Error {
	constructor(value: string) {
		super(`not a space reference: ${value}`);
		this.name = "SpaceRefError";
	}
}
