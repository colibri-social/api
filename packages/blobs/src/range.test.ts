import { describe, expect, it } from "vitest";
import { applyRange, parseRange } from "./range.js";

describe("parseRange", () => {
	it("treats no header as the full resource", () => {
		expect(parseRange(undefined, 1000)).toEqual({ kind: "full" });
		expect(parseRange(null, 1000)).toEqual({ kind: "full" });
	});

	it("parses an open-ended range", () => {
		expect(parseRange("bytes=0-", 1000)).toEqual({ kind: "partial", start: 0, end: 999 });
	});

	it("parses a closed range from zero", () => {
		expect(parseRange("bytes=0-99", 1000)).toEqual({ kind: "partial", start: 0, end: 99 });
	});

	it("parses a closed range in the middle", () => {
		expect(parseRange("bytes=100-199", 1000)).toEqual({ kind: "partial", start: 100, end: 199 });
	});

	it("parses a suffix range", () => {
		expect(parseRange("bytes=-500", 1000)).toEqual({ kind: "partial", start: 500, end: 999 });
	});

	it("clamps a suffix larger than the resource to the whole resource", () => {
		expect(parseRange("bytes=-5000", 1000)).toEqual({ kind: "partial", start: 0, end: 999 });
	});

	it("rejects a start past the end as unsatisfiable", () => {
		expect(parseRange("bytes=999999-", 1000)).toEqual({ kind: "unsatisfiable" });
	});

	it("rejects a reversed range as unsatisfiable", () => {
		expect(parseRange("bytes=5-2", 1000)).toEqual({ kind: "unsatisfiable" });
	});

	it("clamps an end past the last byte", () => {
		expect(parseRange("bytes=900-100000", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
	});

	it("rejects a zero-length suffix as unsatisfiable", () => {
		expect(parseRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
	});

	it("falls back to full for a non-byte unit", () => {
		expect(parseRange("items=0-9", 1000)).toEqual({ kind: "full" });
	});

	it("falls back to full for a multi-range request", () => {
		expect(parseRange("bytes=0-9,20-29", 1000)).toEqual({ kind: "full" });
	});

	it("treats an empty resource as unsatisfiable", () => {
		expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
	});

	it("falls back to full for garbage after bytes=", () => {
		expect(parseRange("bytes=abc-def", 1000)).toEqual({ kind: "full" });
	});
});

describe("applyRange", () => {
	const bytes = new Uint8Array(1000).map((_, index) => index % 256);

	it("returns 200 for the whole resource when there is no range", () => {
		expect(applyRange(bytes, null)).toEqual({ status: 200 });
	});

	it("slices out a normal range and produces headers for a 206", () => {
		const result = applyRange(bytes, "bytes=100-199");
		expect(result).toMatchObject({
			status: 206,
			start: 100,
			end: 199,
			total: 1000,
			contentRange: "bytes 100-199/1000",
			contentLength: 100,
		});
		if (result.status === 206) {
			expect(result.bytes).toEqual(bytes.subarray(100, 200));
		}
	});

	it("slices a suffix range", () => {
		const result = applyRange(bytes, "bytes=-10");
		if (result.status !== 206) throw new Error("expected a partial range");
		expect(result.start).toBe(990);
		expect(result.end).toBe(999);
		expect(result.bytes).toEqual(bytes.subarray(990, 1000));
	});

	it("slices an open-ended range", () => {
		const result = applyRange(bytes, "bytes=990-");
		if (result.status !== 206) throw new Error("expected a partial range");
		expect(result.bytes).toEqual(bytes.subarray(990, 1000));
		expect(result.contentLength).toBe(10);
	});

	it("answers 416 for an unsatisfiable range", () => {
		expect(applyRange(bytes, "bytes=5000-")).toEqual({
			status: 416,
			total: 1000,
			contentRange: "bytes */1000",
		});
	});

	it("answers 416 for a range past the end of the resource", () => {
		const result = applyRange(bytes, "bytes=1000-1010");
		expect(result.status).toBe(416);
	});
});
