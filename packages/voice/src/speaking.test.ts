import { describe, expect, it } from "vitest";
import { applySpeakingTick, createSpeakingTracker, forgetSpeaker } from "./speaking.js";

describe("applySpeakingTick", () => {
	it("marks a newly active did as started immediately", () => {
		const tracker = createSpeakingTracker();
		const result = applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		expect(result).toEqual({ started: ["did:plc:a"], stopped: [] });
	});

	it("does not repeat a start while the did stays active", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		const result = applySpeakingTick(tracker, ["did:plc:a"], 100, 1_000);
		expect(result).toEqual({ started: [], stopped: [] });
	});

	it("does not stop a did before the debounce window elapses", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		const result = applySpeakingTick(tracker, [], 500, 1_000);
		expect(result).toEqual({ started: [], stopped: [] });
	});

	it("stops a did once it has been inactive for the debounce window", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		const result = applySpeakingTick(tracker, [], 1_000, 1_000);
		expect(result).toEqual({ started: [], stopped: ["did:plc:a"] });
	});

	it("restarts a did that becomes active again before the debounce window elapses", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		applySpeakingTick(tracker, [], 500, 1_000);
		const result = applySpeakingTick(tracker, ["did:plc:a"], 600, 1_000);
		expect(result).toEqual({ started: [], stopped: [] });
	});

	it("tracks multiple dids independently", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a", "did:plc:b"], 0, 1_000);
		const result = applySpeakingTick(tracker, ["did:plc:a"], 1_000, 1_000);
		expect(result).toEqual({ started: [], stopped: ["did:plc:b"] });
	});
});

describe("forgetSpeaker", () => {
	it("removes a did so it is treated as newly active next time", () => {
		const tracker = createSpeakingTracker();
		applySpeakingTick(tracker, ["did:plc:a"], 0, 1_000);
		forgetSpeaker(tracker, "did:plc:a");
		const result = applySpeakingTick(tracker, ["did:plc:a"], 1, 1_000);
		expect(result).toEqual({ started: ["did:plc:a"], stopped: [] });
	});
});
