import { InvalidRequestError, UpstreamFailureError } from "@atproto/xrpc-server";
import { CommunityCredentialError } from "@colibri-social/community";
import { IdentityResolutionError, ServiceAuthError } from "@colibri-social/identity";
import { SpaceCredentialError, XrpcError } from "@colibri-social/space";

export class ColibriError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "ColibriError";
	}
}

export const authRequired = (message: string) => new ColibriError("AuthRequired", message, 401);
export const forbidden = (permission: string) =>
	new ColibriError("Forbidden", `this action requires ${permission}`, 403);
export const notFound = (code: string, message: string) => new ColibriError(code, message, 404);
export const invalidRequest = (message: string) => new ColibriError("InvalidRequest", message, 400);

export const toXrpcError = (error: unknown): Error => {
	if (error instanceof ColibriError) {
		return new InvalidRequestError(error.message, error.code);
	}

	if (error instanceof ServiceAuthError) {
		return new InvalidRequestError(error.message, "AuthRequired");
	}

	if (error instanceof IdentityResolutionError) {
		return new InvalidRequestError(error.message, "ActorNotFound");
	}

	if (error instanceof CommunityCredentialError) {
		return new InvalidRequestError(error.message, "CredentialsUnavailable");
	}

	if (error instanceof SpaceCredentialError) {
		if (error.reason === "spaceDeleted") {
			return new InvalidRequestError(error.message, "SpaceNotFound");
		}
		if (error.reason === "refused") return new InvalidRequestError(error.message, "Forbidden");
		return new UpstreamFailureError(error.message, "UpstreamFailure");
	}

	if (error instanceof XrpcError) {
		if (error.isNotFound) return new InvalidRequestError(error.message, "NotFound");
		if (error.isAuthFailure) return new InvalidRequestError(error.message, "Forbidden");
		return new UpstreamFailureError(error.message, "UpstreamFailure");
	}

	return error instanceof Error ? error : new Error(String(error));
};
