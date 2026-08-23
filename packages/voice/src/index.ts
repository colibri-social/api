export * from "./config.js";
export * from "./room.js";
export * from "./sfu.js";
export * from "./speaking.js";
export * from "./typed-emitter.js";
export * from "./worker-pool.js";

import type { VoiceSfuConfigInput } from "./config.js";
import { VoiceSfu, type VoiceSfuDependencies } from "./sfu.js";

export async function createVoiceSfu(
	config: VoiceSfuConfigInput = {},
	deps: VoiceSfuDependencies = {},
): Promise<VoiceSfu> {
	return VoiceSfu.create(config, deps);
}
