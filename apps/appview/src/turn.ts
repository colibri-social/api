import type { IceServer } from "@colibri-social/voice";
import { z } from "zod";

export const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export const TURN_REQUEST_TIMEOUT_MS = 3_000;

const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

const responseSchema = z.object({
	iceServers: z.array(
		z.object({
			urls: z.union([z.string(), z.array(z.string())]),
			username: z.string().optional(),
			credential: z.string().optional(),
		}),
	),
});

export type TurnCredentials = {
	iceServers: () => Promise<IceServer[]>;
};

export type CloudflareTurnOptions = {
	keyId: string;
	apiToken: string;
	log: { warn: (fields: object, message: string) => void };
	fetch?: typeof fetch;
};

const BLOCKED_PORT = /:53(\?|$)/;

const withoutBlockedPorts = (server: IceServer): IceServer | null => {
	const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
		(url) => !BLOCKED_PORT.test(url),
	);

	if (urls.length === 0) {
		return null;
	}

	return { ...server, urls };
};

export const noTurnCredentials: TurnCredentials = {
	iceServers: async () => {
		return [];
	},
};

export const cloudflareTurn = (options: CloudflareTurnOptions): TurnCredentials => {
	const request = options.fetch ?? fetch;
	const url = `${CLOUDFLARE_TURN_API}/${encodeURIComponent(options.keyId)}/credentials/generate-ice-servers`;

	return {
		iceServers: async () => {
			try {
				const response = await request(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${options.apiToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
					signal: AbortSignal.timeout(TURN_REQUEST_TIMEOUT_MS),
				});

				if (!response.ok) {
					options.log.warn({ status: response.status }, "voice.turnCredentialsFailed");

					return [];
				}

				const body = responseSchema.parse(await response.json());

				return body.iceServers.flatMap((server) => {
					const kept = withoutBlockedPorts(server);

					return kept ? [kept] : [];
				});
			} catch (error) {
				options.log.warn({ err: error }, "voice.turnCredentialsFailed");

				return [];
			}
		},
	};
};

export const turnCredentialsFor = (
	config: { TURN_KEY_ID?: string | undefined; TURN_KEY_API_TOKEN?: string | undefined },
	log: CloudflareTurnOptions["log"],
): TurnCredentials => {
	if (!config.TURN_KEY_ID || !config.TURN_KEY_API_TOKEN) {
		return noTurnCredentials;
	}

	return cloudflareTurn({ keyId: config.TURN_KEY_ID, apiToken: config.TURN_KEY_API_TOKEN, log });
};
