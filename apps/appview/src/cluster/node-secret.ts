import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JOIN_PATH, type JoinRequest, joinResponseSchema } from "./protocol.js";

export type JoinOptions = {
	file: string;
	mainUrl: string | undefined;
	token: string | undefined;
	address: Omit<JoinRequest, "token">;
	fetch?: typeof fetch;
};

export const readNodeSecret = async (file: string): Promise<string | null> => {
	try {
		const secret = (await readFile(file, "utf8")).trim();

		return secret === "" ? null : secret;
	} catch {
		return null;
	}
};

export const saveNodeSecret = async (file: string, secret: string): Promise<void> => {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${secret}\n`, { mode: 0o600 });
};

export const joinCluster = async (options: JoinOptions): Promise<string | null> => {
	const stored = await readNodeSecret(options.file);

	if (stored) {
		return stored;
	}

	if (!options.mainUrl || !options.token) {
		return null;
	}

	const request = options.fetch ?? fetch;
	const response = await request(new URL(JOIN_PATH, options.mainUrl), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: options.token, ...options.address } satisfies JoinRequest),
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(`the main node refused the join token (${response.status})`);
	}

	const joined = joinResponseSchema.parse(await response.json());

	await saveNodeSecret(options.file, joined.secret);

	return joined.secret;
};
