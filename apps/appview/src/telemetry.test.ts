import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import type { Heartbeat } from "@colibri-social/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetry, NOTICE_GRACE_MS, type TelemetryDeps } from "./telemetry.js";

let database: TestDatabase;
let clock: Date;
let sent: Heartbeat[];

const deps = (overrides: Partial<TelemetryDeps> = {}): TelemetryDeps => {
	return {
		database,
		log: { info: vi.fn(), warn: vi.fn() },
		enabled: true,
		url: "https://telemetry.test/v1/heartbeat",
		version: "2.40.0",
		flavor: "spaces",
		roles: ["main", "api"],
		voice: true,
		nodes: async () => 3,
		now: () => clock,
		send: async (_url, heartbeat) => {
			sent.push(heartbeat);

			return true;
		},
		...overrides,
	};
};

beforeEach(async () => {
	database = await openTestDatabase();
	clock = new Date("2026-11-11T12:00:00Z");
	sent = [];
});

afterEach(async () => {
	await database.destroy();
});

describe("telemetry", () => {
	it("shows the notice first, waits an hour, then sends once a day", async () => {
		const options = deps();
		const telemetry = createTelemetry(options);

		expect(await telemetry.tick()).toBe("waiting");
		expect(options.log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ notice: expect.stringContaining("COLIBRI_TELEMETRY_DISABLED") }),
			"telemetry.notice",
		);
		expect(await telemetry.tick()).toBe("waiting");

		clock = new Date(clock.getTime() + NOTICE_GRACE_MS);

		expect(await telemetry.tick()).toBe("sent");
		expect(sent[0]).toMatchObject({
			version: "2.40.0",
			flavor: "spaces",
			roles: ["api", "main"],
			nodes: "1-10",
			voice: true,
			spaces: "0",
			users30d: "0",
			voiceMinutes1d: "0",
		});
		expect(sent[0]?.database).toMatch(/^(sqlite|postgres) \d+$/);

		clock = new Date(clock.getTime() + 60 * 60_000);

		expect(await telemetry.tick()).toBe("waiting");

		clock = new Date(clock.getTime() + 24 * 60 * 60_000);

		expect(await telemetry.tick()).toBe("sent");
		expect(sent[1]?.instanceId).toBe(sent[0]?.instanceId);
	});

	it("keeps the instance ID across restarts", async () => {
		await createTelemetry(deps()).tick();
		clock = new Date(clock.getTime() + NOTICE_GRACE_MS);
		await createTelemetry(deps()).tick();
		clock = new Date(clock.getTime() + 25 * 60 * 60_000);
		await createTelemetry(deps()).tick();

		expect(sent).toHaveLength(2);
		expect(sent[1]?.instanceId).toBe(sent[0]?.instanceId);
	});

	it("tries again on the next check after a failed send", async () => {
		const telemetry = createTelemetry(deps({ send: async () => false }));

		await telemetry.tick();
		clock = new Date(clock.getTime() + NOTICE_GRACE_MS);

		expect(await telemetry.tick()).toBe("failed");
		expect(await telemetry.tick()).toBe("failed");
	});

	it("sends nothing and stores nothing when turned off", async () => {
		const telemetry = createTelemetry(deps({ enabled: false }));

		expect(await telemetry.tick()).toBe("disabled");
		expect(await database.db.select().from(database.tables.telemetryState)).toEqual([]);
	});

	it("adds up voice minutes from the participants on every node", async () => {
		const telemetry = createTelemetry(deps());

		await database.db.insert(database.tables.voiceParticipants).values(
			Array.from({ length: 12 }, (_, index) => ({
				channel: "at://did:plc:space/social.colibri.beta.channel/voice",
				did: `did:plc:user${index}`,
				nodeId: index % 2 === 0 ? "eu-1" : "us-1",
				updatedAt: clock.toISOString(),
			})),
		);
		await telemetry.sampleVoice();
		await telemetry.tick();
		clock = new Date(clock.getTime() + NOTICE_GRACE_MS);
		await telemetry.tick();

		expect(sent[0]?.voiceMinutes1d).toBe("11-100");
	});
});
