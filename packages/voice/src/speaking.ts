export type SpeakingTracker = Map<string, { speaking: boolean; lastActiveAt: number }>;

export type SpeakingTickResult = {
	started: string[];
	stopped: string[];
};

export function createSpeakingTracker(): SpeakingTracker {
	return new Map();
}

export function applySpeakingTick(
	tracker: SpeakingTracker,
	activeDids: readonly string[],
	now: number,
	debounceMs: number,
): SpeakingTickResult {
	const started: string[] = [];
	const stopped: string[] = [];
	const activeSet = new Set(activeDids);

	for (const did of activeSet) {
		const entry = tracker.get(did);
		if (!entry) {
			tracker.set(did, { speaking: true, lastActiveAt: now });
			started.push(did);
			continue;
		}
		entry.lastActiveAt = now;
		if (!entry.speaking) {
			entry.speaking = true;
			started.push(did);
		}
	}

	for (const [did, entry] of tracker) {
		if (entry.speaking && !activeSet.has(did) && now - entry.lastActiveAt >= debounceMs) {
			entry.speaking = false;
			stopped.push(did);
		}
	}

	return { started, stopped };
}

export function forgetSpeaker(tracker: SpeakingTracker, did: string): void {
	tracker.delete(did);
}
