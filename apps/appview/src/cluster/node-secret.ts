import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { JOIN_PATH, type JoinRequest, type JoinResponse, joinResponseSchema } from "./protocol.js";

export type NodeCredentials = JoinResponse;

export type JoinOptions = {
	file: string;
	mainUrl: string | undefined;
	token: string | undefined;
	address: Omit<JoinRequest, "token">;
	fetch?: typeof fetch;
};

export const readNodeCredentials = async (file: string): Promise<NodeCredentials | null> => {
	try {
		const parsed = joinResponseSchema.safeParse(JSON.parse(await readFile(file, "utf8")));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

export const saveNodeCredentials = async (
	file: string,
	credentials: NodeCredentials,
): Promise<void> => {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
};

const errorSchema = z.object({ error: z.string() });

export const joinCluster = async (options: JoinOptions): Promise<NodeCredentials | null> => {
	const stored = await readNodeCredentials(options.file);

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
		const body = errorSchema.safeParse(await response.json().catch(() => null));

		throw new Error(
			`the main node refused the join token (${response.status}${body.success ? ` ${body.data.error}` : ""})`,
		);
	}

	const joined = joinResponseSchema.parse(await response.json());

	await saveNodeCredentials(options.file, joined);

	return joined;
};
