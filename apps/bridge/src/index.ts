#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	Bridge,
	bridgeDidDocument,
	ColibriClient,
	createServiceAuthSigner,
	generateSigningKey,
	publicDidKeyFor,
	resolveAppviewDid,
	SqliteBridgeStore,
} from "@colibri-social/bridge-core";
import { DiscordConnector } from "@colibri-social/bridge-discord";
import { pino } from "pino";
import { loadConfig } from "./config.js";
import { serveBridgeHttp } from "./http.js";

const keygen = async () => {
	const key = await generateSigningKey();
	process.stdout.write(
		`BRIDGE_SIGNING_KEY=${key.privateKeyHex}\n# public key for the bridge's DID document: ${key.publicDidKey}\n`,
	);
};

const printDidDocument = async () => {
	const did = process.env.BRIDGE_DID;
	const key = process.env.BRIDGE_SIGNING_KEY;
	if (!did || !key) throw new Error("set BRIDGE_DID and BRIDGE_SIGNING_KEY first");
	process.stdout.write(
		`${JSON.stringify(bridgeDidDocument(did, await publicDidKeyFor(key)), null, 2)}\n`,
	);
};

const run = async () => {
	const config = loadConfig();
	const log = pino({ level: config.LOG_LEVEL });
	const signer = await createServiceAuthSigner(config.BRIDGE_DID, config.BRIDGE_SIGNING_KEY);
	const appviewDid =
		config.COLIBRI_APPVIEW_DID ?? (await resolveAppviewDid(config.COLIBRI_APPVIEW_URL));

	mkdirSync(dirname(config.BRIDGE_DATABASE_PATH), { recursive: true });
	const store = new SqliteBridgeStore(config.BRIDGE_DATABASE_PATH);

	const didDocument = config.BRIDGE_DID.startsWith("did:web:")
		? bridgeDidDocument(config.BRIDGE_DID, await publicDidKeyFor(config.BRIDGE_SIGNING_KEY))
		: null;
	const http = config.BRIDGE_HTTP_PORT
		? serveBridgeHttp(config.BRIDGE_HTTP_PORT, didDocument)
		: null;

	const bridge = new Bridge({
		client: new ColibriClient({
			appviewUrl: config.COLIBRI_APPVIEW_URL,
			appviewDid,
			signer,
		}),
		connector: new DiscordConnector({ token: config.DISCORD_TOKEN }),
		store,
		log: {
			debug: (detail, message) => log.debug(detail, message),
			info: (detail, message) => log.info(detail, message),
			warn: (detail, message) => log.warn(detail, message),
			error: (detail, message) => log.error(detail, message),
		},
	});

	const shutdown = async (signal: string) => {
		log.info({ signal }, "bridge.stopping");
		http?.close();
		await bridge.stop();
		await store.close();
		process.exit(0);
	};
	process.on("unhandledRejection", (reason) =>
		log.error(
			{ error: reason instanceof Error ? reason.message : String(reason) },
			"bridge.unhandledRejection",
		),
	);
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));

	await bridge.start();
	log.info({ did: config.BRIDGE_DID, appview: appviewDid }, "bridge.started");
};

const commands: Record<string, () => Promise<void>> = {
	keygen,
	"did-document": printDidDocument,
	run,
};

const command = commands[process.argv[2] ?? "run"];
if (!command) {
	process.stderr.write("usage: colibri-bridge [run | keygen | did-document]\n");
	process.exit(1);
}
command().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
