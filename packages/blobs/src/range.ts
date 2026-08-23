export type RangeParseResult =
	| { kind: "full" }
	| { kind: "partial"; start: number; end: number }
	| { kind: "unsatisfiable" };

const BYTES_PREFIX = "bytes=";
const DIGITS = /^\d+$/;

const parseSafeInteger = (raw: string): number | null => {
	if (!DIGITS.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
};

export const parseRange = (header: string | null | undefined, total: number): RangeParseResult => {
	if (!header) return { kind: "full" };

	const trimmed = header.trim();
	if (!trimmed.startsWith(BYTES_PREFIX)) return { kind: "full" };

	const spec = trimmed.slice(BYTES_PREFIX.length).trim();
	if (spec.includes(",")) return { kind: "full" };

	const dashIndex = spec.indexOf("-");
	if (dashIndex < 0) return { kind: "full" };

	const startPart = spec.slice(0, dashIndex).trim();
	const endPart = spec.slice(dashIndex + 1).trim();

	if (total === 0) return { kind: "unsatisfiable" };

	if (startPart === "") {
		const suffix = parseSafeInteger(endPart);
		if (suffix === null) return { kind: "full" };
		if (suffix === 0) return { kind: "unsatisfiable" };
		return { kind: "partial", start: Math.max(total - suffix, 0), end: total - 1 };
	}

	const start = parseSafeInteger(startPart);
	if (start === null) return { kind: "full" };
	if (start >= total) return { kind: "unsatisfiable" };

	let end: number;
	if (endPart === "") {
		end = total - 1;
	} else {
		const parsedEnd = parseSafeInteger(endPart);
		if (parsedEnd === null) return { kind: "full" };
		end = parsedEnd;
	}

	if (end < start) return { kind: "unsatisfiable" };

	return { kind: "partial", start, end: Math.min(end, total - 1) };
};

export type RangeApplyResult =
	| { status: 200 }
	| {
			status: 206;
			bytes: Uint8Array;
			start: number;
			end: number;
			total: number;
			contentRange: string;
			contentLength: number;
	  }
	| { status: 416; total: number; contentRange: string };

export const applyRange = (
	bytes: Uint8Array,
	header: string | null | undefined,
): RangeApplyResult => {
	const total = bytes.byteLength;
	const parsed = parseRange(header, total);

	if (parsed.kind === "full") return { status: 200 };

	if (parsed.kind === "unsatisfiable") {
		return { status: 416, total, contentRange: `bytes */${total}` };
	}

	const { start, end } = parsed;
	return {
		status: 206,
		bytes: bytes.subarray(start, end + 1),
		start,
		end,
		total,
		contentRange: `bytes ${start}-${end}/${total}`,
		contentLength: end - start + 1,
	};
};
