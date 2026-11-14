import type { Server } from "@atproto/xrpc-server";
import { social } from "@colibri-social/lexicons";
import { fetchVerifiedRepo } from "@colibri-social/space-sync";
import type { AuthVerifiers } from "../auth.js";
import type { AppContext } from "../context.js";
import { toXrpcError } from "../errors.js";
import { route } from "../route.js";
import { markReferenced, mountPolyfillBlobRoutes } from "./blobs.js";
import { spacesSupport, spacesSupportProbe } from "./detect.js";
import { hostedChecker } from "./host-mode.js";
import { beginMigration, completeMigration, listForMigration } from "./migration.js";
import type { PolyfillDeps } from "./state.js";
import { getPolyfillStatus } from "./status.js";
import {
	applyPolyfillWrites,
	getPolyfillRecord,
	listPolyfillRecords,
	type PolyfillWrite,
} from "./writes.js";

const polyfill = social.colibri.beta.polyfill;

type InputWrite = social.colibri.beta.polyfill.applyWrites.$InputBody["writes"][number];

const json = <T>(body: T) => {
	return { encoding: "application/json" as const, body };
};

const toWrite = (write: InputWrite): PolyfillWrite => {
	if (polyfill.applyWrites.delete.isTypeOf(write)) {
		return { kind: "delete", collection: write.collection, rkey: write.rkey };
	}

	if (polyfill.applyWrites.update.isTypeOf(write)) {
		return { kind: "update", collection: write.collection, rkey: write.rkey, value: write.value };
	}

	return {
		kind: "create",
		collection: write.collection,
		...(write.rkey ? { rkey: write.rkey } : {}),
		value: write.value,
	};
};

const resultType = (write: InputWrite): string => {
	if (polyfill.applyWrites.delete.isTypeOf(write)) return polyfill.applyWrites.deleteResult.$type;
	if (polyfill.applyWrites.update.isTypeOf(write)) return polyfill.applyWrites.updateResult.$type;

	return polyfill.applyWrites.createResult.$type;
};

const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		throw toXrpcError(error);
	}
};

export const polyfillDepsFor = (ctx: AppContext): PolyfillDeps => {
	const blobIndex = ctx.polyfillBlobs.index;
	const pdsOf = async (did: string) => {
		return (await ctx.identity.resolveDid(did)).pds ?? null;
	};

	return {
		database: ctx.database,
		projections: ctx.projections,
		loader: ctx.loader,
		support: spacesSupport({ database: ctx.database, probe: spacesSupportProbe() }),
		pdsOf,
		publish: (change) => ctx.sync.publish(change),
		fetchRepo: (space, author) => {
			return fetchVerifiedRepo(
				{
					client: ctx.spaceClient,
					hosts: {
						hostFor: async (did) => (await pdsOf(did)) ?? ctx.config.PDS_URL,
					},
					keys: ctx.identity,
					maxRepoBytes: ctx.config.SYNC_MAX_CAR_BYTES,
				},
				space,
				author,
			);
		},
		markReferenced: (author, cids) => markReferenced(blobIndex, author, cids),
	};
};

export const registerPolyfillRoutes = ({
	server,
	ctx,
	auth,
}: {
	server: Server;
	ctx: AppContext;
	auth: AuthVerifiers;
}): void => {
	const deps = polyfillDepsFor(ctx);

	route(server, polyfill.getStatus, {
		auth: auth.required,
		handler: ({ auth: caller }) => {
			return guarded(async () => json(await getPolyfillStatus(deps, caller.credentials.did)));
		},
	});

	route(server, polyfill.applyWrites, {
		auth: auth.required,
		handler: ({ input, auth: caller }) => {
			return guarded(async () => {
				const writes = input.body.writes;
				const outcome = await applyPolyfillWrites(deps, caller.credentials.did, {
					space: input.body.space,
					writes: writes.map(toWrite),
				});

				return json({
					rev: outcome.rev,
					results: outcome.results.map((result, index) => {
						const write = writes[index] as InputWrite;

						return { $type: resultType(write), ...result };
					}),
				} as never);
			});
		},
	});

	route(server, polyfill.getRecord, {
		auth: auth.required,
		handler: ({ params, auth: caller }) => {
			return guarded(async () => {
				return json((await getPolyfillRecord(deps, caller.credentials.did, params)) as never);
			});
		},
	});

	route(server, polyfill.listRecords, {
		auth: auth.required,
		handler: ({ params, auth: caller }) => {
			return guarded(async () => {
				return json((await listPolyfillRecords(deps, caller.credentials.did, params)) as never);
			});
		},
	});

	route(server, polyfill.beginMigration, {
		auth: auth.required,
		handler: ({ auth: caller }) => {
			return guarded(async () => {
				return json((await beginMigration(deps, caller.credentials.did)) as never);
			});
		},
	});

	route(server, polyfill.listForMigration, {
		auth: auth.required,
		handler: ({ params, auth: caller }) => {
			return guarded(async () => {
				return json((await listForMigration(deps, caller.credentials.did, params)) as never);
			});
		},
	});

	route(server, polyfill.completeMigration, {
		auth: auth.required,
		handler: ({ input, auth: caller }) => {
			return guarded(async () => {
				return json((await completeMigration(deps, caller.credentials.did, input.body)) as never);
			});
		},
	});

	mountPolyfillBlobRoutes(server, auth, {
		...ctx.polyfillBlobs,
		isHosted: hostedChecker(ctx.database),
	});
};
