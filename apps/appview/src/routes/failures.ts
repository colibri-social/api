import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	CommunityCredentialError,
	type MembershipError,
	type ModerationError,
} from "@colibri-social/community";

export const credentialsUnavailable = (error: CommunityCredentialError) =>
	new InvalidRequestError(error.message, "CredentialsUnavailable");

export const membershipErrorToXrpc = (error: MembershipError): InvalidRequestError => {
	switch (error.failure) {
		case "communityNotFound":
			return new InvalidRequestError(error.message, "CommunityNotFound");
		case "alreadyMember":
			return new InvalidRequestError(error.message, "AlreadyMember");
		case "banned":
			return new InvalidRequestError(error.message, "Banned");
		case "invitationNotFound":
			return new InvalidRequestError(error.message, "InvitationNotFound");
		case "notMember":
			return new InvalidRequestError(error.message, "MemberNotFound");
		case "soleOwner":
			return new InvalidRequestError(error.message, "SoleOwner");
		case "applicationNotFound":
			return new InvalidRequestError(error.message, "ApplicationNotFound");
		case "roleNotFound":
			return new InvalidRequestError(error.message, "RoleNotFound");
		case "hierarchy":
			return new InvalidRequestError(error.message, "RoleHierarchy");
	}
};

export const moderationErrorToXrpc = (error: ModerationError): InvalidRequestError => {
	switch (error.failure) {
		case "notMember":
			return new InvalidRequestError(error.message, "MemberNotFound");
		case "hierarchy":
			return new InvalidRequestError(error.message, "RoleHierarchy");
		case "alreadyBanned":
			return new InvalidRequestError(error.message, "AlreadyBanned");
		case "notBanned":
			return new InvalidRequestError(error.message, "NotBanned");
		case "labelNotFound":
			return new InvalidRequestError(error.message, "LabelNotFound");
	}
};

export const isCredentialError = (error: unknown): error is CommunityCredentialError =>
	error instanceof CommunityCredentialError;
