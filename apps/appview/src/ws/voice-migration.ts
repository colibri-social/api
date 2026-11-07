import { probeUrlOf, signalingUrlOf, type VoiceNode } from "../voice-calls.js";

export type MigrationCandidate = {
	nodeId: string;
	region: string;
	signalingUrl: string;
	probeUrl: string;
};

export type RttResult = {
	nodeId: string;
	rttMs?: number;
};

export type Migration = {
	candidates: MigrationCandidate[];
	deadline: Date;
	reports: Map<string, RttResult[]>;
	timer: ReturnType<typeof setTimeout> | null;
	target: MigrationCandidate | null;
};

export const candidateOf = (node: VoiceNode): MigrationCandidate => {
	return {
		nodeId: node.id,
		region: node.region,
		signalingUrl: signalingUrlOf(node),
		probeUrl: probeUrlOf(node),
	};
};

const worstRtt = (candidate: MigrationCandidate, reports: Iterable<RttResult[]>): number => {
	let worst = 0;

	for (const results of reports) {
		const rtt = results.find((result) => result.nodeId === candidate.nodeId)?.rttMs;

		worst = Math.max(worst, rtt ?? Number.POSITIVE_INFINITY);
	}

	return worst;
};

export const pickTarget = (
	candidates: readonly MigrationCandidate[],
	reports: ReadonlyMap<string, RttResult[]>,
): MigrationCandidate | null => {
	let best: MigrationCandidate | null = null;
	let bestRtt = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		const rtt = worstRtt(candidate, reports.values());

		if (best === null || rtt < bestRtt) {
			best = candidate;
			bestRtt = rtt;
		}
	}

	return best;
};
