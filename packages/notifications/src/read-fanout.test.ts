import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadPushTarget } from "./push.js";
import { createReadFanout, type ReadFanout } from "./read-fanout.js";

const CHANNEL = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1";
const OTHER = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel2";
const THREAD = "at://did:plc:community/space/social.colibri.beta.channel.thread/3lkthread1";

let delivered: { did: string; target: ReadPushTarget }[];
let fanout: ReadFanout;

beforeEach(() => {
	vi.useFakeTimers();
	delivered = [];
	fanout = createReadFanout({
		deliver: async (did, target) => {
			delivered.push({ did, target });
		},
	});
});

afterEach(() => {
	fanout.close();
	vi.useRealTimers();
});

describe("read fan-out", () => {
	it("debounces a burst for one user and channel into the newest cursor", async () => {
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg2" });
		await vi.advanceTimersByTimeAsync(600);
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg4" });
		await vi.advanceTimersByTimeAsync(600);
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg3" });
		await vi.advanceTimersByTimeAsync(999);

		expect(delivered).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(delivered).toEqual([
			{ did: "did:plc:a", target: { channel: CHANNEL, through: "3lkmsg4" } },
		]);
	});

	it("keeps users, channels and threads apart", async () => {
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg1" });
		fanout.schedule("did:plc:a", { channel: OTHER, through: "3lkmsg1" });
		fanout.schedule("did:plc:a", { channel: CHANNEL, thread: THREAD, through: "3lkmsg1" });
		fanout.schedule("did:plc:b", { channel: CHANNEL, through: "3lkmsg1" });
		await vi.advanceTimersByTimeAsync(1000);

		expect(delivered).toHaveLength(4);
	});

	it("skips a cursor that is not past the last one sent", async () => {
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg5" });
		await vi.advanceTimersByTimeAsync(1000);
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg5" });
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg2" });
		await vi.advanceTimersByTimeAsync(1000);

		expect(delivered).toHaveLength(1);

		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg6" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(delivered.map((entry) => entry.target.through)).toEqual(["3lkmsg5", "3lkmsg6"]);
	});

	it("flushes pending reads at once", async () => {
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg1" });
		await fanout.flush();

		expect(delivered).toHaveLength(1);
	});

	it("reports a failed delivery and keeps going", async () => {
		const errors: unknown[] = [];
		const failing = createReadFanout({
			deliver: async () => {
				throw new Error("provider down");
			},
			onError: (error) => errors.push(error),
		});
		failing.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg1" });
		await failing.flush();

		expect(errors).toHaveLength(1);
		failing.close();
	});

	it("drops pending reads on close", async () => {
		fanout.schedule("did:plc:a", { channel: CHANNEL, through: "3lkmsg1" });
		fanout.close();
		await vi.advanceTimersByTimeAsync(2000);

		expect(delivered).toEqual([]);
	});
});
