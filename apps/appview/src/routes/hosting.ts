import { randomUUID } from "node:crypto";
import { OAuthCallbackError } from "@atproto/oauth-client-node";
import { InvalidRequestError } from "@atproto/xrpc-server";
import {
	CommunityCredentialError,
	communitySpaceUris,
	isAdmin,
	ProvisioningRefused,
} from "@colibri-social/community";
import { asDatetime, asDid, asUri, social } from "@colibri-social/lexicons";
import { XrpcError } from "@colibri-social/space";
import { and, eq } from "drizzle-orm";
import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { backfillDefaultRole } from "../heal.js";
import { HOST_OAUTH_PATHS, type HostSignIn } from "../host-oauth.js";
import { route } from "../route.js";
import { asyncHandler } from "./async-handler.js";
import type { RouteDeps } from "./types.js";

type HostingView = social.colibri.beta.community.getHosting.HostingView;

export type HostSignInFailure =
	| "cancelled"
	| "wrongAccount"
	| "spacesUnsupported"
	| "alreadyHosts"
	| "failed";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const communityNotFound = () =>
	new InvalidRequestError("no community exists at that identifier", "CommunityNotFound");

const requireAdmin = async (ctx: AppContext, community: string, caller: string) => {
	const row = await ctx.loader.community(community);
	if (!row) throw communityNotFound();
	const authz = await ctx.loader.authz(community, caller);
	if (!isAdmin(authz)) {
		throw new InvalidRequestError(
			"only an administrator of this community may manage its hosting",
			"Forbidden",
		);
	}
	return row;
};

const resolveAccount = async (ctx: AppContext, identifier: string): Promise<string> => {
	const trimmed = identifier.trim().replace(/^@/, "");
	if (trimmed.startsWith("did:")) return trimmed;
	try {
		return await ctx.identity.resolveHandle(trimmed.toLowerCase());
	} catch {
		throw new InvalidRequestError(`could not find an account called ${trimmed}`, "InvalidRequest");
	}
};

export const handleAuthorizeHost = async (
	ctx: AppContext,
	caller: string,
	input: {
		identifier: string;
		intent: string;
		community?: string;
		name?: string;
		description?: string;
		requiresApprovalToJoin?: boolean;
	},
): Promise<social.colibri.beta.community.authorizeHost.$OutputBody> => {
	const hostOAuth = ctx.hostOAuth;
	if (!hostOAuth) {
		throw new InvalidRequestError(
			"this AppView has no host sign-in configured",
			"HostSignInUnavailable",
		);
	}

	let expected: string;
	if (input.intent === "adopt") {
		if (!input.name?.trim()) {
			throw new InvalidRequestError("a new community needs a name", "InvalidRequest");
		}
		expected = await resolveAccount(ctx, input.identifier);
		if (await ctx.loader.community(expected)) {
			throw new InvalidRequestError(`${expected} is already a community here`, "AlreadyExists");
		}
	} else if (input.intent === "reconnect") {
		if (!input.community) {
			throw new InvalidRequestError("reconnecting needs the community", "InvalidRequest");
		}
		await requireAdmin(ctx, input.community, caller);
		expected = input.community;
	} else {
		throw new InvalidRequestError(`unknown intent ${input.intent}`, "InvalidRequest");
	}

	const id = randomUUID();
	const now = new Date().toISOString();
	await ctx.database.db.insert(ctx.database.tables.hostAuthorizations).values({
		id,
		actor: caller,
		intent: input.intent,
		identifier: input.identifier.trim(),
		community: expected,
		input:
			input.intent === "adopt"
				? {
						name: input.name?.trim(),
						description: input.description,
						requiresApprovalToJoin: input.requiresApprovalToJoin,
					}
				: null,
		status: "pending",
		failure: null,
		result: null,
		createdAt: now,
		updatedAt: now,
	});

	let url: URL;
	try {
		url = await hostOAuth.authorize(expected, id);
	} catch (error) {
		await settle(ctx, id, { status: "failed", failure: "failed" });
		throw new InvalidRequestError(
			error instanceof Error
				? `could not start signing in to ${input.identifier} (${error.message})`
				: `could not start signing in to ${input.identifier}`,
			"UpstreamFailure",
		);
	}
	return { authorizeUrl: asUri(url.toString()), request: id };
};

const settle = async (
	ctx: AppContext,
	id: string,
	outcome: { status: "done" | "failed"; failure?: HostSignInFailure; result?: string },
): Promise<void> => {
	const table = ctx.database.tables.hostAuthorizations;
	await ctx.database.db
		.update(table)
		.set({
			status: outcome.status,
			failure: outcome.failure ?? null,
			result: outcome.result ?? null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(table.id, id));
};

export const handleGetHostAuthorization = async (
	ctx: AppContext,
	caller: string,
	request: string,
): Promise<social.colibri.beta.community.getHostAuthorization.$OutputBody> => {
	const table = ctx.database.tables.hostAuthorizations;
	const [row] = await ctx.database.db
		.select()
		.from(table)
		.where(and(eq(table.id, request), eq(table.actor, caller)))
		.limit(1);
	if (!row) {
		throw new InvalidRequestError("no sign-in exists with that request", "RequestNotFound");
	}
	const wrongAccount = row.failure?.startsWith("wrongAccount:");
	return {
		status: row.status,
		...(row.result ? { community: asDid(row.result) } : {}),
		...(row.failure ? { failure: wrongAccount ? "wrongAccount" : row.failure } : {}),
		...(wrongAccount ? { signedInAs: row.failure?.slice("wrongAccount:".length) } : {}),
	};
};

const spacesUnsupported = (error: unknown): boolean =>
	error instanceof XrpcError && (error.status === 501 || error.code === "MethodNotImplemented");

const finishAdopt = async (
	ctx: AppContext,
	row: typeof ctx.database.tables.hostAuthorizations.$inferSelect,
	signIn: HostSignIn,
): Promise<{ failure?: HostSignInFailure; result?: string }> => {
	const did = signIn.session.did;
	if (await ctx.loader.community(did)) return { failure: "alreadyHosts" };
	try {
		await ctx.provisioner.adoptAuthorized(signIn.host, {
			did,
			name: row.input?.name ?? signIn.host.session.handle,
			description: row.input?.description,
			requiresApprovalToJoin: row.input?.requiresApprovalToJoin,
			creator: row.actor,
		});
		return { result: did };
	} catch (error) {
		if (error instanceof ProvisioningRefused && error.reason === "alreadyASpaceCommunity") {
			return { failure: "alreadyHosts" };
		}
		await ctx.credentials.forget(did).catch(() => undefined);
		if (spacesUnsupported(error)) return { failure: "spacesUnsupported" };
		ctx.log.warn({ community: did, err: error }, "hostSignIn.adoptFailed");
		return { failure: "failed" };
	}
};

const finishReconnect = async (
	ctx: AppContext,
	row: typeof ctx.database.tables.hostAuthorizations.$inferSelect,
	signIn: HostSignIn,
): Promise<{ failure?: HostSignInFailure; result?: string }> => {
	const community = signIn.session.did;
	try {
		await signIn.host.pds.listSpaces(signIn.host.session);
	} catch (error) {
		if (spacesUnsupported(error)) return { failure: "spacesUnsupported" };
		throw error;
	}
	await ctx.credentials.storeOAuth({
		community,
		pdsEndpoint: signIn.host.pds.service,
		identifier: signIn.host.session.handle,
		connectedBy: row.actor,
	});
	for (const space of await communitySpaceUris(ctx.database, community)) ctx.sync.wake(space);
	void backfillDefaultRole(ctx, community).catch((error: unknown) =>
		ctx.log.warn({ community, err: error }, "hostSignIn.backfillFailed"),
	);
	return { result: community };
};

export const finishSignIn = async (
	ctx: AppContext,
	signIn: HostSignIn,
): Promise<{ id: string; failure?: HostSignInFailure }> => {
	const table = ctx.database.tables.hostAuthorizations;
	const [row] = await ctx.database.db
		.select()
		.from(table)
		.where(eq(table.id, signIn.request))
		.limit(1);
	if (row?.status !== "pending") {
		return { id: signIn.request, failure: "failed" };
	}

	if (row.community && signIn.session.did !== row.community) {
		if (!(await ctx.credentials.has(signIn.session.did))) {
			await ctx.hostOAuth?.revoke(signIn.session.did).catch(() => undefined);
		}
		const failure = `wrongAccount:${signIn.host.session.handle}`;
		await ctx.database.db
			.update(table)
			.set({ status: "failed", failure, updatedAt: new Date().toISOString() })
			.where(eq(table.id, row.id));
		return { id: row.id, failure: "wrongAccount" };
	}

	const outcome =
		row.intent === "adopt"
			? await finishAdopt(ctx, row, signIn)
			: await finishReconnect(ctx, row, signIn);
	await settle(ctx, row.id, {
		status: outcome.failure ? "failed" : "done",
		failure: outcome.failure,
		result: outcome.result,
	});
	return { id: row.id, failure: outcome.failure };
};

const RETURN_PAGE = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080808;color:#fafafa;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:24px;text-align:center}
h1{font-size:22px;margin:0 0 8px}
p{margin:0;color:#a1a1a1}
</style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`;

const returnTo = (
	ctx: AppContext,
	res: Response,
	outcome: { id?: string; failure?: HostSignInFailure },
): void => {
	const target = ctx.config.HOST_OAUTH_RETURN_URL;
	if (target) {
		const url = new URL(target);
		if (outcome.id) url.searchParams.set("hostRequest", outcome.id);
		url.searchParams.set("hostStatus", outcome.failure ? "failed" : "done");
		if (outcome.failure) url.searchParams.set("hostFailure", outcome.failure);
		res.redirect(303, url.toString());
		return;
	}
	res
		.status(outcome.failure ? 400 : 200)
		.type("html")
		.send(
			outcome.failure
				? RETURN_PAGE("Signing in didn't work", "Go back to Colibri to see what happened.")
				: RETURN_PAGE("You're signed in", "Go back to Colibri. You can close this tab."),
		);
};

export const mountHostOAuthRoutes = (ctx: AppContext, app: Router): void => {
	app.get(HOST_OAUTH_PATHS.metadata, (_req: Request, res: Response) => {
		if (!ctx.hostOAuth) {
			res.status(404).json({ error: "NotFound", message: "host sign-in is not configured" });
			return;
		}
		res.json(ctx.hostOAuth.clientMetadata);
	});

	app.get(HOST_OAUTH_PATHS.jwks, (_req: Request, res: Response) => {
		if (!ctx.hostOAuth) {
			res.status(404).json({ error: "NotFound", message: "host sign-in is not configured" });
			return;
		}
		res.json(ctx.hostOAuth.jwks);
	});

	app.get(
		HOST_OAUTH_PATHS.callback,
		asyncHandler(ctx, "hostSignIn.callbackFailed", async (req: Request, res: Response) => {
			const hostOAuth = ctx.hostOAuth;
			if (!hostOAuth) {
				returnTo(ctx, res, { failure: "failed" });
				return;
			}
			const params = new URLSearchParams(req.originalUrl.split("?")[1] ?? "");
			let signIn: HostSignIn;
			try {
				signIn = await hostOAuth.callback(params);
			} catch (error) {
				const request = error instanceof OAuthCallbackError ? error.state : undefined;
				const failure: HostSignInFailure =
					params.get("error") === "access_denied" ? "cancelled" : "failed";
				if (request) await settle(ctx, request, { status: "failed", failure });
				if (failure === "failed") ctx.log.warn({ err: error }, "hostSignIn.callbackRejected");
				returnTo(ctx, res, { id: request ?? undefined, failure });
				return;
			}
			const outcome = await finishSignIn(ctx, signIn).catch(async (error: unknown) => {
				ctx.log.warn({ err: error }, "hostSignIn.finishFailed");
				await settle(ctx, signIn.request, { status: "failed", failure: "failed" });
				return { id: signIn.request, failure: "failed" as const };
			});
			returnTo(ctx, res, outcome);
		}),
	);
};

export const handleGetHosting = async (
	ctx: AppContext,
	caller: string,
	community: string,
): Promise<{ hosting: HostingView }> => {
	await requireAdmin(ctx, community, caller);
	const record = await ctx.credentials.describe(community);
	if (!record) throw communityNotFound();
	const colibri =
		record.source !== "oauth" &&
		record.pdsEndpoint.replace(/\/$/, "") === ctx.pds.service.replace(/\/$/, "");
	return {
		hosting: {
			kind: colibri ? "colibri" : "own",
			account: record.identifier,
			server: asUri(record.pdsEndpoint),
			needsSignIn: record.needsReauthAt !== null,
			connectedAt: asDatetime(record.createdAt),
			...(record.connectedBy ? { connectedBy: asDid(record.connectedBy) } : {}),
			...(record.needsReauthAt ? { needsSignInSince: asDatetime(record.needsReauthAt) } : {}),
			...(record.handOver ? { handOverExpiresAt: asDatetime(record.handOver.expiresAt) } : {}),
		},
	};
};

export const handleHandOverHost = async (
	ctx: AppContext,
	caller: string,
	input: { community: string; email: string },
): Promise<social.colibri.beta.community.handOverHost.$OutputBody> => {
	await requireAdmin(ctx, input.community, caller);
	const email = input.email.trim();
	if (!EMAIL.test(email)) {
		throw new InvalidRequestError("that email address doesn't look right", "InvalidRequest");
	}
	try {
		const result = await ctx.credentials.handOver(input.community, {
			email,
			handedOverBy: caller,
		});
		return {
			identifier: result.identifier,
			password: result.password,
			expiresAt: asDatetime(result.expiresAt),
		};
	} catch (error) {
		if (error instanceof CommunityCredentialError && error.failure === "handOverUnavailable") {
			throw new InvalidRequestError(error.message, "HandOverUnavailable");
		}
		if (error instanceof XrpcError) {
			throw new InvalidRequestError(error.message, "UpstreamFailure");
		}
		throw error;
	}
};

export const registerHostingRoutes = ({ server, ctx, auth }: RouteDeps): void => {
	route(server, social.colibri.beta.community.authorizeHost, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleAuthorizeHost(ctx, caller.credentials.did, input.body),
		}),
	});

	route(server, social.colibri.beta.community.getHostAuthorization, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetHostAuthorization(ctx, caller.credentials.did, params.request),
		}),
	});

	route(server, social.colibri.beta.community.getHosting, {
		auth: auth.required,
		handler: async ({ params, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleGetHosting(ctx, caller.credentials.did, params.community),
		}),
	});

	route(server, social.colibri.beta.community.handOverHost, {
		auth: auth.required,
		handler: async ({ input, auth: caller }) => ({
			encoding: "application/json" as const,
			body: await handleHandOverHost(ctx, caller.credentials.did, input.body),
		}),
	});
};
