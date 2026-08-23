import { describe, expect, it } from "vitest";
import { isBlockedIp } from "./net.js";

describe("isBlockedIp", () => {
	it("blocks IPv4 loopback", () => {
		expect(isBlockedIp("127.0.0.1")).toBe(true);
		expect(isBlockedIp("127.255.255.255")).toBe(true);
	});

	it("blocks IPv4 private ranges", () => {
		expect(isBlockedIp("10.0.0.1")).toBe(true);
		expect(isBlockedIp("10.255.255.255")).toBe(true);
		expect(isBlockedIp("172.16.0.1")).toBe(true);
		expect(isBlockedIp("172.31.255.255")).toBe(true);
		expect(isBlockedIp("192.168.0.1")).toBe(true);
		expect(isBlockedIp("192.168.255.255")).toBe(true);
	});

	it("blocks IPv4 link-local", () => {
		expect(isBlockedIp("169.254.0.1")).toBe(true);
		expect(isBlockedIp("169.254.255.255")).toBe(true);
	});

	it("blocks IPv4 unspecified and this-network", () => {
		expect(isBlockedIp("0.0.0.0")).toBe(true);
		expect(isBlockedIp("0.1.2.3")).toBe(true);
	});

	it("blocks IPv4 multicast and broadcast", () => {
		expect(isBlockedIp("224.0.0.1")).toBe(true);
		expect(isBlockedIp("239.255.255.255")).toBe(true);
		expect(isBlockedIp("255.255.255.255")).toBe(true);
	});

	it("blocks IPv4 CGNAT shared address space", () => {
		expect(isBlockedIp("100.64.0.1")).toBe(true);
		expect(isBlockedIp("100.127.255.255")).toBe(true);
	});

	it("blocks IPv4 documentation ranges", () => {
		expect(isBlockedIp("192.0.2.1")).toBe(true);
		expect(isBlockedIp("198.51.100.1")).toBe(true);
		expect(isBlockedIp("203.0.113.1")).toBe(true);
	});

	it("allows public IPv4 addresses", () => {
		expect(isBlockedIp("1.1.1.1")).toBe(false);
		expect(isBlockedIp("8.8.8.8")).toBe(false);
		expect(isBlockedIp("93.184.216.34")).toBe(false);
		expect(isBlockedIp("100.63.255.255")).toBe(false);
		expect(isBlockedIp("100.128.0.0")).toBe(false);
	});

	it("blocks IPv6 loopback and unspecified", () => {
		expect(isBlockedIp("::1")).toBe(true);
		expect(isBlockedIp("::")).toBe(true);
	});

	it("blocks IPv6 unique-local and link-local", () => {
		expect(isBlockedIp("fc00::1")).toBe(true);
		expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
		expect(isBlockedIp("fe80::1")).toBe(true);
		expect(isBlockedIp("febf:ffff:ffff:ffff::1")).toBe(true);
	});

	it("blocks IPv6 multicast", () => {
		expect(isBlockedIp("ff02::1")).toBe(true);
	});

	it("allows public IPv6 addresses", () => {
		expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
		expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
	});

	it("blocks IPv4-mapped IPv6 forms of blocked addresses", () => {
		expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
		expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
		expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
		expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
		expect(isBlockedIp("[::ffff:127.0.0.1]")).toBe(true);
	});

	it("allows IPv4-mapped IPv6 forms of public addresses", () => {
		expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
	});

	it("normalizes octal and decimal IPv4 forms via the URL parser before the check runs", () => {
		expect(new URL("http://0177.0.0.1/").hostname).toBe("127.0.0.1");
		expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
		expect(new URL("http://017700000001/").hostname).toBe("127.0.0.1");
		expect(new URL("http://0x7f000001/").hostname).toBe("127.0.0.1");
		expect(isBlockedIp(new URL("http://0177.0.0.1/").hostname)).toBe(true);
		expect(isBlockedIp(new URL("http://2130706433/").hostname)).toBe(true);
		expect(isBlockedIp(new URL("http://017700000001/").hostname)).toBe(true);
		expect(isBlockedIp(new URL("http://0x7f000001/").hostname)).toBe(true);
	});

	it("blocks anything that is not a parseable IP literal", () => {
		expect(isBlockedIp("not-an-ip")).toBe(true);
		expect(isBlockedIp("999.999.999.999")).toBe(true);
	});
});
