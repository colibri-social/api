import { randomUUID } from "node:crypto";
import type { Database } from "@colibri-social/appview-db";
import {
	buildHeartbeat,
	type Heartbeat,
	heartbeatDue,
	sendHeartbeat,
	TELEMETRY_NOTICE,
} from "@colibri-social/telemetry";
import { count, eq, gt, sql } from "drizzle-orm";
import type { Logger } from "./logger.js";

export const TELEMETRY_STATE_ID = "instance";

export const NOTICE_GRACE_MS = 60 * 60_000;

export const CHECK_MS = 60 * 60_000;

export const VOICE_SAMPLE_MS = 60_000;

export const VOICE_WINDOW = 24 * 60;

export type TelemetryDeps = {
	database: Pick<Database, "db" | "primary" | "tables" | "dialect">;
	log: Pick<Logger, "info" | "warn">;
	enabled: boolean;
	url: string;
	version: string;
	flavor: string;
	roles: readonly string[];
	voice: boolean;
	nodes: () => Promise<number>;
	now?: () => Date;
	send?: (url: string, heartbeat: Heartbeat) => Promise<boolean>;
};

export type Telemetry = {
	tick: () => Promise<"disabled" | "waiting" | "sent" | "failed">;
	sampleVoice: () => Promise<void>;
	stop: () => void;
};

type State = {
	instanceId: string;
	noticeShownAt: string | null;
	lastSentAt: string | null;
};

const databaseVersion = async (database: TelemetryDeps["database"]): Promise<string> => {
	if (database.dialect === "postgres") {
		const result = (await (
			database.primary as unknown as {
				execute: (query: unknown) => Promise<{ rows: { version: string }[] }>;
			}
		).execute(sql`select current_setting('server_version_num') as version`)) ?? { rows: [] };
		const number = Number(result.rows[0]?.version ?? 0);

		return `postgres ${Math.floor(number / 10_000)}`;
	}

	const row = (await (
		database.primary as unknown as { get: (query: unknown) => Promise<{ version: string }> }
	).get(sql`select sqlite_version() as version`)) ?? { version: "" };

	return `sqlite ${row.version.split(".")[0] ?? ""}`.trim();
};

export const createTelemetry = (deps: TelemetryDeps): Telemetry => {
	const now = deps.now ?? (() => new Date());
	const send =
		deps.send ??
		((url, heartbeat) =>
			sendHeartbeat(url, heartbeat, {
				userAgent: `colibri-appview/${deps.version}`,
			}));
	const { primary, tables } = deps.database;
	const voiceSamples: number[] = [];
	let disabledLogged = false;

	const loadState = async (): Promise<State> => {
		const [row] = await primary
			.select()
			.from(tables.telemetryState)
			.where(eq(tables.telemetryState.id, TELEMETRY_STATE_ID))
			.limit(1);

		if (row) {
			return row;
		}

		const created = { instanceId: randomUUID(), noticeShownAt: null, lastSentAt: null };

		await primary
			.insert(tables.telemetryState)
			.values({ id: TELEMETRY_STATE_ID, ...created })
			.onConflictDoNothing();

		return created;
	};

	const update = async (values: Partial<State>): Promise<void> => {
		await primary
			.update(tables.telemetryState)
			.set(values)
			.where(eq(tables.telemetryState.id, TELEMETRY_STATE_ID));
	};

	const collect = async (state: State): Promise<Heartbeat> => {
		const since = new Date(now().getTime() - 30 * 24 * 60 * 60_000).toISOString();
		const [spaces] = await deps.database.db.select({ value: count() }).from(tables.communities);
		const [users] = await deps.database.db
			.select({ value: count() })
			.from(tables.userPresence)
			.where(gt(tables.userPresence.updatedAt, since));

		return buildHeartbeat({
			instanceId: state.instanceId,
			version: deps.version,
			flavor: deps.flavor,
			roles: deps.roles,
			nodes: await deps.nodes(),
			database: await databaseVersion(deps.database).catch(() => deps.database.dialect),
			os: process.platform,
			nodeVersion: process.version,
			voice: deps.voice,
			spaces: Number(spaces?.value ?? 0),
			users30d: Number(users?.value ?? 0),
			voiceMinutes1d: voiceSamples.reduce((total, sample) => total + sample, 0),
		});
	};

	return {
		tick: async () => {
			if (!deps.enabled) {
				if (!disabledLogged) deps.log.info("telemetry.disabled");
				disabledLogged = true;

				return "disabled";
			}

			const state = await loadState();
			const at = now();

			if (!state.noticeShownAt) {
				deps.log.warn({ notice: TELEMETRY_NOTICE }, "telemetry.notice");
				await update({ noticeShownAt: at.toISOString() });

				return "waiting";
			}

			const noticeAge = at.getTime() - new Date(state.noticeShownAt).getTime();
			const lastSentAt = state.lastSentAt ? new Date(state.lastSentAt) : null;

			if (noticeAge < NOTICE_GRACE_MS || !heartbeatDue(lastSentAt, at)) {
				return "waiting";
			}

			const heartbeat = await collect(state);

			if (!(await send(deps.url, heartbeat))) {
				deps.log.info("telemetry.sendFailed");

				return "failed";
			}

			await update({ lastSentAt: at.toISOString() });
			deps.log.info({ heartbeat }, "telemetry.sent");

			return "sent";
		},
		sampleVoice: async () => {
			const [row] = await deps.database.db
				.select({ value: count() })
				.from(tables.voiceParticipants);

			voiceSamples.push(Number(row?.value ?? 0) * (VOICE_SAMPLE_MS / 60_000));

			if (voiceSamples.length > VOICE_WINDOW) voiceSamples.shift();
		},
		stop: () => {
			voiceSamples.length = 0;
		},
	};
};

export const startTelemetry = (deps: TelemetryDeps): Telemetry & { stop: () => void } => {
	const telemetry = createTelemetry(deps);
	const run = () => {
		void telemetry
			.tick()
			.catch((error: unknown) => deps.log.warn({ err: error }, "telemetry.failed"));
	};
	const checks = setInterval(run, CHECK_MS);
	const samples = deps.voice
		? setInterval(() => {
				void telemetry
					.sampleVoice()
					.catch((error: unknown) => deps.log.warn({ err: error }, "telemetry.voiceSampleFailed"));
			}, VOICE_SAMPLE_MS)
		: null;

	checks.unref?.();
	samples?.unref?.();
	run();

	return {
		...telemetry,
		stop: () => {
			clearInterval(checks);
			if (samples) clearInterval(samples);
			telemetry.stop();
		},
	};
};
