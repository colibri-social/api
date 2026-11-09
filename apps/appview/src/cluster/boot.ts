import { hostname } from "node:os";
import { resolveVersion } from "../routes/server.js";
import { joinCluster, type NodeCredentials } from "./node-secret.js";
import {
	CONFIG_PATH,
	configResponseSchema,
	NODE_ID_HEADER,
	NODE_SECRET_HEADER,
	notMainSchema,
} from "./protocol.js";

export const DEFAULT_NODE_SECRET_FILE = "./data/node-secret";

export const DEFAULT_CLUSTER_PORT = 3100;

export type BootOptions = {
	fetch?: typeof fetch;
	attempts?: number;
	retryMs?: number;
	log?: (message: string) => void;
};

const fetchConfig = async (
	mainUrl: string,
	credentials: NodeCredentials,
	request: typeof fetch,
): Promise<
	{ kind: "values"; values: Record<string, string> } | { kind: "redirect"; main: string | null }
> => {
	const response = await request(new URL(CONFIG_PATH, mainUrl), {
		headers: { [NODE_ID_HEADER]: credentials.id, [NODE_SECRET_HEADER]: credentials.secret },
		signal: AbortSignal.timeout(10_000),
	});
	const body: unknown = await response.json().catch(() => null);

	if (response.status === 503) {
		const notMain = notMainSchema.safeParse(body);

		if (notMain.success) {
			return { kind: "redirect", main: notMain.data.main };
		}
	}

	if (!response.ok) {
		throw new Error(`the main node refused to hand out the configuration (${response.status})`);
	}

	return { kind: "values", values: configResponseSchema.parse(body).values };
};

export const resolveClusterEnv = async (
	env: NodeJS.ProcessEnv,
	options: BootOptions = {},
): Promise<NodeJS.ProcessEnv> => {
	const mainUrl = env.MAIN_NODE_URL;

	if (!mainUrl) {
		return env;
	}

	const request = options.fetch ?? fetch;
	const attempts = options.attempts ?? 24;
	const retryMs = options.retryMs ?? 5_000;
	const port = env.CLUSTER_PORT || String(DEFAULT_CLUSTER_PORT);
	const publicUrl = env.NODE_PUBLIC_URL || env.PUBLIC_URL;
	const file = env.NODE_SECRET_FILE || DEFAULT_NODE_SECRET_FILE;
	let target = mainUrl;
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const credentials = await joinCluster({
				file,
				mainUrl: target,
				token: env.CLUSTER_JOIN_TOKEN,
				fetch: request,
				address: {
					publicUrl: publicUrl ?? "",
					tailnetUrl: env.NODE_TAILNET_URL || `http://${hostname()}:${port}`,
					...(env.SFU_ANNOUNCED_IP ? { announcedIp: env.SFU_ANNOUNCED_IP } : {}),
					version: resolveVersion(),
				},
			});

			if (!credentials) {
				return env;
			}

			const answer = await fetchConfig(target, credentials, request);

			if (answer.kind === "values") {
				return { ...answer.values, ...env };
			}

			if (!answer.main) {
				throw new Error("no node is main right now");
			}

			options.log?.(`following the main node to ${answer.main}`);
			target = answer.main;
		} catch (error) {
			lastError = error;
			options.log?.(
				`could not reach the main node at ${target} (${error instanceof Error ? error.message : String(error)}), attempt ${attempt} of ${attempts}`,
			);

			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, retryMs));
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error("could not reach the main node");
};
