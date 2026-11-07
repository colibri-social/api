import { describe, expect, it } from "vitest";
import {
	candidateOf,
	type MigrationCandidate,
	pickTarget,
	type RttResult,
} from "./voice-migration.js";

const node = (id: string, region: string): MigrationCandidate => {
	return candidateOf({ id, region, publicUrl: `https://${id}.nodes.colibri.social` });
};

const FRANKFURT = node("eu-2", "eu");
const VIRGINIA = node("us-1", "us");

describe("candidateOf", () => {
	it("signals on the node's public URL and probes its health route", () => {
		expect(FRANKFURT).toEqual({
			nodeId: "eu-2",
			region: "eu",
			signalingUrl: "https://eu-2.nodes.colibri.social",
			probeUrl: "https://eu-2.nodes.colibri.social/health",
		});
	});
});

describe("pickTarget", () => {
	it("picks the node with the lowest worst-case round trip", () => {
		const reports = new Map<string, RttResult[]>([
			[
				"did:plc:berlin",
				[
					{ nodeId: "eu-2", rttMs: 20 },
					{ nodeId: "us-1", rttMs: 110 },
				],
			],
			[
				"did:plc:boston",
				[
					{ nodeId: "eu-2", rttMs: 95 },
					{ nodeId: "us-1", rttMs: 15 },
				],
			],
		]);

		expect(pickTarget([VIRGINIA, FRANKFURT], reports)).toBe(FRANKFURT);
	});

	it("avoids a node a participant could not reach", () => {
		const reports = new Map<string, RttResult[]>([
			["did:plc:a", [{ nodeId: "eu-2" }, { nodeId: "us-1", rttMs: 200 }]],
			[
				"did:plc:b",
				[
					{ nodeId: "eu-2", rttMs: 10 },
					{ nodeId: "us-1", rttMs: 150 },
				],
			],
		]);

		expect(pickTarget([FRANKFURT, VIRGINIA], reports)).toBe(VIRGINIA);
	});

	it("falls back to the first candidate without reports", () => {
		expect(pickTarget([FRANKFURT, VIRGINIA], new Map())).toBe(FRANKFURT);
	});

	it("returns nothing without candidates", () => {
		expect(pickTarget([], new Map())).toBeNull();
	});
});
