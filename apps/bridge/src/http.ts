import { createServer, type Server } from "node:http";
import type { BridgeDidDocument } from "@colibri-social/bridge-core";

export const serveBridgeHttp = (port: number, didDocument: BridgeDidDocument | null): Server => {
	const server = createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
			return;
		}
		if (req.url === "/.well-known/did.json" && didDocument) {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(didDocument));
			return;
		}
		res.writeHead(404).end();
	});
	server.listen(port);
	return server;
};
