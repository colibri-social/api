import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";

const BEGIN_MIGRATION = "social.colibri.beta.polyfill.beginMigration";

const spacesOf = (body: Buffer): string[] => {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { spaces?: unknown };

		return Array.isArray(parsed.spaces)
			? parsed.spaces.filter((space): space is string => typeof space === "string")
			: [];
	} catch {
		return [];
	}
};

export const beginRemoteMigrations = async (
	ctx: Pick<AppContext, "config" | "database" | "identity" | "forwarder" | "log">,
	did: string,
): Promise<string[]> => {
	if (!ctx.config.FEDERATION_ENABLED) return [];

	const table = ctx.database.tables.remoteSpaces;

	const rows = await ctx.database.db
		.selectDistinct({ managingApp: table.managingApp })
		.from(table)
		.where(eq(table.did, did));

	const apps = rows
		.map((row) => row.managingApp)
		.filter((app) => !ctx.config.appviewDids.includes(app));

	const started = await Promise.all(
		apps.map(async (managingApp) => {
			try {
				const endpoint = await ctx.identity.serviceEndpointFor(managingApp, "colibri_appview");

				if (!endpoint) return [];

				const answer = await ctx.forwarder(
					{ managingApp, endpoint },
					{
						method: "POST",
						path: `/xrpc/${BEGIN_MIGRATION}`,
						nsid: BEGIN_MIGRATION,
						headers: { "content-type": "application/json" },
						body: Buffer.from("{}"),
						actingFor: did,
					},
				);

				if (answer.status === 200) return spacesOf(answer.body);

				ctx.log.warn({ managingApp, status: answer.status }, "federation.migrationRefused");

				return [];
			} catch (error) {
				ctx.log.warn({ managingApp, err: error }, "federation.migrationUnreachable");

				return [];
			}
		}),
	);

	return started.flat();
};
