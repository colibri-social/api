import { describe, expect, it } from "vitest";
import {
	type ActorAuthz,
	type CategoryAudience,
	type ChannelState,
	canPost,
	canRead,
	inheritCategory,
	isPrivateCategory,
} from "./authz.js";

const COMMUNITY = "did:plc:community";

const channel = (overrides: Partial<ChannelState> = {}): ChannelState => ({
	space: `at://${COMMUNITY}/space/general`,
	skey: "general",
	ownerOnly: false,
	allowedRoles: [],
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
	...overrides,
});

const category = (overrides: Partial<CategoryAudience> = {}): CategoryAudience => ({
	ownerOnly: false,
	allowedRoles: [],
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
	...overrides,
});

const member = (did: string, roles: string[] = []): ActorAuthz => ({
	actor: did,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: { did, roles, joinedAt: "2026-10-01T00:00:00.000Z", nickname: null },
	roles: roles.map((rkey) => ({
		rkey,
		name: rkey,
		permissions: [],
		position: 10,
		hoisted: false,
		mentionable: false,
		protected: false,
		channelOverrides: [],
	})),
});

describe("category inheritance", () => {
	it("leaves a channel alone outside a category", () => {
		const open = channel();
		expect(inheritCategory(open, null)).toBe(open);
	});

	it("makes an open channel in a private category private", () => {
		const state = inheritCategory(channel(), category({ visibleToRoles: ["staff"] }));
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(true);
		expect(canRead(member("did:plc:b"), state)).toBe(false);
	});

	it("lets a channel's own visibility override the category's", () => {
		const state = inheritCategory(
			channel({ visibleToMembers: ["did:plc:b"] }),
			category({ visibleToRoles: ["staff"] }),
		);
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(false);
		expect(canRead(member("did:plc:b"), state)).toBe(true);
	});

	it("inherits posting rules separately from visibility", () => {
		const state = inheritCategory(
			channel({ visibleToRoles: ["staff"] }),
			category({ allowedRoles: ["leads"] }),
		);
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(true);
		expect(canPost(member("did:plc:a", ["staff"]), state)).toBe(false);
		expect(canPost(member("did:plc:c", ["staff", "leads"]), state)).toBe(true);
	});

	it("lets a channel's own posting rule override the category's", () => {
		const state = inheritCategory(
			channel({ allowedMembers: ["did:plc:a"] }),
			category({ ownerOnly: true }),
		);
		expect(canPost(member("did:plc:a"), state)).toBe(true);
	});

	it("reports a category as private only when it restricts reading", () => {
		expect(isPrivateCategory(category({ ownerOnly: true }))).toBe(false);
		expect(isPrivateCategory(category({ visibleToMembers: ["did:plc:a"] }))).toBe(true);
	});
});
