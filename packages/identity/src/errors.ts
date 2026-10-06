export type ServiceAuthFailure =
	| "malformed"
	| "expired"
	| "lifetimeTooLong"
	| "wrongAudience"
	| "wrongMethod"
	| "badSignature"
	| "unresolvableIssuer";

export class ServiceAuthError extends Error {
	constructor(
		readonly failure: ServiceAuthFailure,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ServiceAuthError";
	}
}

export class IdentityResolutionError extends Error {
	constructor(
		readonly subject: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "IdentityResolutionError";
	}
}

export class MissingPdsError extends IdentityResolutionError {
	constructor(subject: string, options?: { cause?: unknown }) {
		super(subject, `${subject} publishes no #atproto_pds service`, options);
		this.name = "MissingPdsError";
	}
}
