import net from "node:net";

const stripBrackets = (hostname: string): string =>
	hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const ipv4ToInt = (ip: string): number => {
	const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
	return (
		(((octets[0] ?? 0) << 24) |
			((octets[1] ?? 0) << 16) |
			((octets[2] ?? 0) << 8) |
			(octets[3] ?? 0)) >>>
		0
	);
};

const inIpv4Range = (address: number, base: string, maskBits: number): boolean => {
	const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
	return (address & mask) === (ipv4ToInt(base) & mask);
};

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["255.255.255.255", 32],
];

const isBlockedIpv4 = (ip: string): boolean => {
	const address = ipv4ToInt(ip);
	return IPV4_BLOCKED_RANGES.some(([base, bits]) => inIpv4Range(address, base, bits));
};

const parseIpv6Groups = (ip: string): number[] | undefined => {
	const halves = ip.split("::");
	if (halves.length > 2) return undefined;

	const splitGroups = (value: string | undefined): string[] =>
		value === undefined || value.length === 0 ? [] : value.split(":");

	const head = splitGroups(halves[0]);
	const tail = splitGroups(halves[1]);

	const expandEmbeddedIpv4 = (groups: string[]): boolean => {
		const last = groups.at(-1);
		if (!last?.includes(".")) return true;
		if (!net.isIPv4(last)) return false;
		const bytes = last.split(".").map((part) => Number.parseInt(part, 10));
		groups.pop();
		groups.push((((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16));
		groups.push((((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16));
		return true;
	};

	if (!expandEmbeddedIpv4(head) || !expandEmbeddedIpv4(tail)) return undefined;

	if (halves.length === 1) {
		if (head.length !== 8) return undefined;
		return head.map((group) => Number.parseInt(group, 16));
	}

	const missing = 8 - (head.length + tail.length);
	if (missing < 0) return undefined;

	const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
	if (groups.length !== 8) return undefined;
	return groups.map((group) => Number.parseInt(group === "" ? "0" : group, 16));
};

const isBlockedIpv6Groups = (groups: number[]): boolean => {
	const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (isIpv4Mapped) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		const bytes = [high >> 8, high & 0xff, low >> 8, low & 0xff];
		return isBlockedIpv4(bytes.join("."));
	}

	if (groups.every((group) => group === 0)) return true;

	const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
	if (isLoopback) return true;

	const first = groups[0] ?? 0;
	const isUniqueLocal = (first & 0xfe00) === 0xfc00;
	const isLinkLocal = (first & 0xffc0) === 0xfe80;
	const isMulticast = (first & 0xff00) === 0xff00;
	return isUniqueLocal || isLinkLocal || isMulticast;
};

export const isBlockedIp = (rawAddress: string): boolean => {
	const address = stripBrackets(rawAddress);

	if (net.isIPv4(address)) return isBlockedIpv4(address);

	if (net.isIPv6(address)) {
		const groups = parseIpv6Groups(address);
		return groups === undefined ? true : isBlockedIpv6Groups(groups);
	}

	return true;
};
