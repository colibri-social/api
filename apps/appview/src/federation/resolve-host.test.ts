import { describe, expect, it, vi } from "vitest";
import {
	type CachedSpaceHost,
	createSpaceHostResolver,
	SPACE_HOST_MISS_TTL_MS,
	SPACE_HOST_TTL_MS,
	type SpaceHostDeps,
} from "./resolve-host.js";

const OURS = "did:web:appview.example";
const ALIAS = "did:web:alias.example";
const THEIRS = "did:web:other.example";
const SPACE = "did:plc:spacexxxxxxxxxxxxxxxxxxxxx";
const START = new Date("2026-11-26T12:00:00.000Z");

const setup = (overrides: Partial<SpaceHostDeps> = {}) => {
	const cache = new Map<string, CachedSpaceHost>();
	let clock = START.getTime();
	const deps: SpaceHostDeps = {
		self: [OURS, ALIAS],
		localManagingApp: vi.fn(async () => undefined),
		load: async (authority) => cache.get(authority),
		save: async (entry) => {
			cache.set(entry.authority, entry);
		},
		publishedManagingApp: vi.fn(async () => THEIRS),
		endpointFor: vi.fn(async () => "https://other.example"),
		now: () => new Date(clock),
		...overrides,
	};

	return {
		deps,
		cache,
		resolver: createSpaceHostResolver(deps),
		advance: (ms: number) => {
			clock += ms;
		},
	};
};

describe("createSpaceHostResolver", () => {
	it("answers locally for a community this AppView manages, without a network lookup", async () => {
		const { deps, resolver } = setup({ localManagingApp: async () => ALIAS });

		await expect(resolver.resolve(SPACE)).resolves.toEqual({ local: true, managingApp: OURS });
		expect(deps.publishedManagingApp).not.toHaveBeenCalled();
	});

	it("treats a local community without a managing app as its own", async () => {
		const { resolver } = setup({ localManagingApp: async () => null });

		await expect(resolver.resolve(SPACE)).resolves.toEqual({ local: true, managingApp: OURS });
	});

	it("follows the published host record to another AppView and caches it", async () => {
		const { deps, resolver, advance } = setup();

		await expect(resolver.resolve(SPACE)).resolves.toEqual({
			local: false,
			managingApp: THEIRS,
			endpoint: "https://other.example",
		});

		advance(SPACE_HOST_TTL_MS - 1);
		await resolver.resolve(SPACE);
		expect(deps.publishedManagingApp).toHaveBeenCalledOnce();

		advance(2);
		await resolver.resolve(SPACE);
		expect(deps.publishedManagingApp).toHaveBeenCalledTimes(2);
	});

	it("prefers the published record over a stale local row naming another AppView", async () => {
		const { resolver } = setup({
			localManagingApp: async () => "did:web:old.example",
			publishedManagingApp: async () => OURS,
		});

		await expect(resolver.resolve(SPACE)).resolves.toEqual({ local: true, managingApp: OURS });
	});

	it("remembers a missing record for a short time only", async () => {
		const { deps, resolver, advance } = setup({
			publishedManagingApp: vi.fn(async () => undefined),
		});

		await expect(resolver.resolve(SPACE)).resolves.toBeUndefined();
		await resolver.resolve(SPACE);
		expect(deps.publishedManagingApp).toHaveBeenCalledOnce();

		advance(SPACE_HOST_MISS_TTL_MS);
		await resolver.resolve(SPACE);
		expect(deps.publishedManagingApp).toHaveBeenCalledTimes(2);
	});

	it("gives up on an AppView without a #colibri_appview service", async () => {
		const { resolver, cache } = setup({ endpointFor: async () => undefined });

		await expect(resolver.resolve(SPACE)).resolves.toBeUndefined();
		expect(cache.get(SPACE)).toMatchObject({ managingApp: THEIRS, endpoint: null });
	});

	it("shares one lookup between concurrent callers", async () => {
		const { deps, resolver } = setup();

		await Promise.all([resolver.resolve(SPACE), resolver.resolve(SPACE)]);
		expect(deps.publishedManagingApp).toHaveBeenCalledOnce();
	});

	it("looks the community up again after forget", async () => {
		const { deps, resolver } = setup();

		await resolver.resolve(SPACE);
		await resolver.forget(SPACE);
		await resolver.resolve(SPACE);
		expect(deps.publishedManagingApp).toHaveBeenCalledTimes(2);
	});

	it("passes a failed lookup on without caching it", async () => {
		const { resolver, cache } = setup({
			publishedManagingApp: async () => {
				throw new Error("network down");
			},
		});

		await expect(resolver.resolve(SPACE)).rejects.toThrow("network down");
		expect(cache.has(SPACE)).toBe(false);
	});
});
