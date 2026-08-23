import { parseArgs } from "node:util";
import { loadConfig } from "@colibri-social/appview/config";
import { createContext } from "@colibri-social/appview/context";
import { CommunityWriter, migrateCommunity } from "@colibri-social/community";
import { SERVICE_FRAGMENTS, serviceId } from "@colibri-social/identity";

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			community: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});

	if (!values.community) {
		console.error("usage: colibri-migrate --community did:plc:... [--dry-run]");
		process.exit(2);
	}

	const config = loadConfig();
	const ctx = await createContext(config);
	const writer = new CommunityWriter({ credentials: ctx.credentials });

	const report = await migrateCommunity(
		{
			database: ctx.database,
			hostFor: (did) => ctx.hosts.hostFor(did),
			credentials: ctx.credentials,
			writer,
			appviewService: serviceId(config.APPVIEW_DID, SERVICE_FRAGMENTS.appview),
			log: (message, detail) => ctx.log.info(detail ?? {}, message),
			dryRun: values["dry-run"],
		},
		values.community,
	);

	console.log(JSON.stringify(report, null, 2));
	for (const warning of report.warnings) console.warn(`warning: ${warning}`);

	await ctx.close();
	process.exit(0);
};

await main();
