import { describe, expect, it } from "vitest";
import {
	formatPostgresUrl,
	type HostProbe,
	hostUrls,
	isMultiHost,
	parsePostgresUrl,
	pickPrimary,
} from "./hosts.js";

const probe = (url: string, overrides: Partial<HostProbe> = {}): HostProbe => {
	return { url, reachable: true, recovery: false, readOnly: false, epoch: 1, ...overrides };
};

describe("parsePostgresUrl", () => {
	it("reads every host of a multi-host URL", () => {
		expect(
			parsePostgresUrl(
				"postgres://col%40ibri:p%2Fw@hel-1:5432,100.64.0.2:5433,[fd7a::1]/colibri?sslmode=disable",
			),
		).toEqual({
			user: "col@ibri",
			password: "p/w",
			database: "colibri",
			hosts: [
				{ host: "hel-1", port: 5432 },
				{ host: "100.64.0.2", port: 5433 },
				{ host: "fd7a::1", port: 5432 },
			],
			query: "?sslmode=disable",
		});
	});

	it("formats one URL per host and keeps the rest", () => {
		expect(hostUrls("postgres://u:p@a:5432,b/db?x=1")).toEqual([
			"postgres://u:p@a:5432/db?x=1",
			"postgres://u:p@b:5432/db?x=1",
		]);
		expect(formatPostgresUrl(parsePostgresUrl("postgres://u:p@[fd7a::1]:5432/db"))).toBe(
			"postgres://u:p@[fd7a::1]:5432/db",
		);
		expect(isMultiHost("postgres://u:p@a,b/db")).toBe(true);
		expect(isMultiHost("postgres://u:p@a/db")).toBe(false);
		expect(isMultiHost("file:./colibri.db")).toBe(false);
	});
});

describe("pickPrimary", () => {
	it("takes the writable host with the highest epoch", () => {
		expect(
			pickPrimary([
				probe("hel", { epoch: 1 }),
				probe("fsn", { epoch: 2 }),
				probe("sub", { recovery: true, epoch: 3 }),
			])?.url,
		).toBe("fsn");
	});

	it("skips fenced, standby and unreachable hosts", () => {
		expect(
			pickPrimary([
				probe("hel", { readOnly: true, epoch: 5 }),
				probe("fsn", { reachable: false }),
				probe("sub", { recovery: true }),
			]),
		).toBeNull();
	});

	it("keeps the first host on a tie", () => {
		expect(pickPrimary([probe("hel"), probe("fsn")])?.url).toBe("hel");
	});
});
