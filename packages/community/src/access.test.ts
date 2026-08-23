import { SPACE_TYPES } from "@colibri-social/lexicons";
import { describe, expect, it } from "vitest";
import { decideSpaceAccess } from "./access.js";
import {
	type ActorAuthz,
	type ChannelState,
	canPost,
	canRead,
	effectivePermissions,
	has,
	highestPosition,
	isAdmin,
	outranks,
	outranksPosition,
	type RoleState,
} from "./authz.js";

const COMMUNITY = "did:plc:community";
const ACTOR = "did:plc:actor";
const OTHER = "did:plc:other";

const role = (overrides: Partial<RoleState> = {}): RoleState => ({
	rkey: "3lkrole",
	name: "Role",
	permissions: [],
	position: 1,
	hoisted: false,
	mentionable: false,
	protected: false,
	channelOverrides: [],
	...overrides,
});

const authz = (overrides: Partial<ActorAuthz> = {}): ActorAuthz => ({
	actor: ACTOR,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: { did: ACTOR, roles: [], joinedAt: "2026-01-01T00:00:00.000Z", nickname: null },
	roles: [],
	...overrides,
});

const stranger = () => authz({ member: null });

const channel = (overrides: Partial<ChannelState> = {}): ChannelState => ({
	space: "at://did:plc:community/space/social.colibri.channel.text/3lkchan",
	skey: "3lkchan",
	ownerOnly: false,
	allowedRoles: [],
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
	...overrides,
});

describe("permissions", () => {
	it("grants the community itself everything", () => {
		const owner = authz({ isOwner: true });
		expect(has(owner, "community.delete")).toBe(true);
		expect(effectivePermissions(owner)).toContain("role.manage");
	});

	it("grants nothing to a member with no roles", () => {
		expect(has(authz(), "member.kick")).toBe(false);
		expect(effectivePermissions(authz())).toEqual([]);
	});

	it("grants a permission listed on any held role", () => {
		expect(has(authz({ roles: [role({ permissions: ["member.kick"] })] }), "member.kick")).toBe(
			true,
		);
	});

	it("lets a channel override grant a permission the base role lacks", () => {
		const scoped = authz({
			roles: [
				role({ channelOverrides: [{ channel: "3lkchan", allow: ["label.apply"], deny: [] }] }),
			],
		});
		expect(has(scoped, "label.apply")).toBe(false);
		expect(has(scoped, "label.apply", "3lkchan")).toBe(true);
	});

	it("lets a channel override deny a permission the base role grants", () => {
		const scoped = authz({
			roles: [
				role({
					permissions: ["label.apply"],
					channelOverrides: [{ channel: "3lkchan", allow: [], deny: ["label.apply"] }],
				}),
			],
		});
		expect(has(scoped, "label.apply")).toBe(true);
		expect(has(scoped, "label.apply", "3lkchan")).toBe(false);
	});

	it("lets deny beat allow when two roles disagree in the same channel", () => {
		const conflicted = authz({
			roles: [
				role({
					rkey: "a",
					channelOverrides: [{ channel: "3lkchan", allow: ["label.apply"], deny: [] }],
				}),
				role({
					rkey: "b",
					channelOverrides: [{ channel: "3lkchan", allow: [], deny: ["label.apply"] }],
				}),
			],
		});
		expect(has(conflicted, "label.apply", "3lkchan")).toBe(false);
	});

	it("ignores an override belonging to another channel", () => {
		const scoped = authz({
			roles: [
				role({
					permissions: ["label.apply"],
					channelOverrides: [{ channel: "3lkother", allow: [], deny: ["label.apply"] }],
				}),
			],
		});
		expect(has(scoped, "label.apply", "3lkchan")).toBe(true);
	});

	it("grants nothing to a banned actor, whatever roles they still hold", () => {
		const banned = authz({ isBanned: true, roles: [role({ permissions: ["community.manage"] })] });
		expect(has(banned, "community.manage")).toBe(false);
	});
});

describe("hierarchy", () => {
	it("treats a protected role holder as an admin", () => {
		expect(isAdmin(authz({ roles: [role({ protected: true })] }))).toBe(true);
		expect(isAdmin(authz({ roles: [role()] }))).toBe(false);
	});

	it("puts the community above every role", () => {
		expect(highestPosition(authz({ isOwner: true }))).toBe(Number.POSITIVE_INFINITY);
		expect(outranks(authz({ isOwner: true }), authz({ roles: [role({ position: 9999 })] }))).toBe(
			true,
		);
	});

	it("refuses to let anyone outrank the community", () => {
		expect(outranks(authz({ roles: [role({ position: 9999 })] }), authz({ isOwner: true }))).toBe(
			false,
		);
	});

	it("requires a strictly higher position to act on someone", () => {
		const high = authz({ roles: [role({ position: 5 })] });
		const same = authz({ actor: OTHER, roles: [role({ rkey: "b", position: 5 })] });
		const low = authz({ actor: OTHER, roles: [role({ rkey: "c", position: 4 })] });
		expect(outranks(high, same)).toBe(false);
		expect(outranks(high, low)).toBe(true);
	});

	it("lets anyone with a role outrank someone with none", () => {
		expect(outranks(authz({ roles: [role({ position: 1 })] }), authz({ actor: OTHER }))).toBe(true);
		expect(outranks(authz(), authz({ actor: OTHER }))).toBe(false);
	});

	it("compares against a bare position for role edits", () => {
		expect(outranksPosition(authz({ roles: [role({ position: 5 })] }), 4)).toBe(true);
		expect(outranksPosition(authz({ roles: [role({ position: 5 })] }), 5)).toBe(false);
		expect(outranksPosition(authz(), 0)).toBe(false);
	});
});

describe("channel visibility", () => {
	it("lets every member read a channel with no visibility list", () => {
		expect(canRead(authz(), channel())).toBe(true);
	});

	it("keeps a read-only announcement channel readable by everyone", () => {
		const announcements = channel({ allowedRoles: ["3lkadmin"] });
		expect(canRead(authz(), announcements)).toBe(true);
		expect(canPost(authz(), announcements)).toBe(false);
	});

	it("hides a private channel from members outside its lists", () => {
		const private_ = channel({ visibleToRoles: ["3lksecret"] });
		expect(canRead(authz(), private_)).toBe(false);
		expect(canRead(authz({ roles: [role({ rkey: "3lksecret" })] }), private_)).toBe(true);
	});

	it("admits a named member to a private channel without a role", () => {
		expect(canRead(authz(), channel({ visibleToMembers: [ACTOR] }))).toBe(true);
	});

	it("admits an admin to every channel", () => {
		const admin = authz({ roles: [role({ protected: true })] });
		expect(canRead(admin, channel({ visibleToRoles: ["3lksecret"] }))).toBe(true);
	});

	it("admits nobody who is not a member", () => {
		expect(canRead(stranger(), channel())).toBe(false);
	});

	it("admits nobody who is banned", () => {
		expect(canRead(authz({ isBanned: true }), channel())).toBe(false);
	});
});

describe("posting", () => {
	it("lets an unrestricted member post", () => {
		expect(canPost(authz(), channel())).toBe(true);
	});

	it("locks an owner-only channel to admins", () => {
		expect(canPost(authz(), channel({ ownerOnly: true }))).toBe(false);
		expect(
			canPost(authz({ roles: [role({ protected: true })] }), channel({ ownerOnly: true })),
		).toBe(true);
	});

	it("honours an allow-list by role and by member", () => {
		expect(canPost(authz(), channel({ allowedRoles: ["3lkspeaker"] }))).toBe(false);
		expect(
			canPost(
				authz({ roles: [role({ rkey: "3lkspeaker" })] }),
				channel({ allowedRoles: ["3lkspeaker"] }),
			),
		).toBe(true);
		expect(canPost(authz(), channel({ allowedMembers: [ACTOR] }))).toBe(true);
	});

	it("never lets someone post where they cannot read", () => {
		expect(
			canPost(authz(), channel({ visibleToRoles: ["3lksecret"], allowedMembers: [ACTOR] })),
		).toBe(false);
	});
});

describe("space access decisions", () => {
	const decide = (
		spaceType: string,
		state: ActorAuthz,
		options: Partial<{ profileIsPublic: boolean; channel: ChannelState | null }> = {},
	) =>
		decideSpaceAccess({
			spaceType,
			authz: state,
			visibility: { profileIsPublic: options.profileIsPublic ?? true },
			channel: options.channel ?? null,
		});

	it("lets anyone read a public profile", () => {
		expect(decide(SPACE_TYPES.communityProfile, stranger()).authorized).toBe(true);
	});

	it("restricts a private community's profile to members", () => {
		expect(
			decide(SPACE_TYPES.communityProfile, stranger(), { profileIsPublic: false }).authorized,
		).toBe(false);
		expect(
			decide(SPACE_TYPES.communityProfile, authz(), { profileIsPublic: false }).authorized,
		).toBe(true);
	});

	it("restricts configuration and members to members", () => {
		for (const type of [SPACE_TYPES.communityConfiguration, SPACE_TYPES.communityMembers]) {
			expect(decide(type, stranger()).authorized).toBe(false);
			expect(decide(type, authz()).authorized).toBe(true);
		}
	});

	it("restricts the moderation log to holders of moderation.viewLog", () => {
		expect(decide(SPACE_TYPES.communityModeration, authz()).authorized).toBe(false);
		expect(
			decide(
				SPACE_TYPES.communityModeration,
				authz({ roles: [role({ permissions: ["moderation.viewLog"] })] }),
			).authorized,
		).toBe(true);
	});

	it("refuses a channel it cannot find, rather than guessing", () => {
		expect(decide(SPACE_TYPES.channelText, authz(), { channel: null }).authorized).toBe(false);
	});

	it("follows channel visibility for a channel space", () => {
		expect(decide(SPACE_TYPES.channelText, authz(), { channel: channel() }).authorized).toBe(true);
		expect(
			decide(SPACE_TYPES.channelText, authz(), {
				channel: channel({ visibleToRoles: ["3lksecret"] }),
			}).authorized,
		).toBe(false);
	});

	it("always admits the community itself", () => {
		const owner = authz({ isOwner: true });
		expect(decide(SPACE_TYPES.communityModeration, owner).authorized).toBe(true);
		expect(decide(SPACE_TYPES.channelText, owner, { channel: null }).authorized).toBe(true);
	});

	it("refuses a banned member every space", () => {
		const banned = authz({ isBanned: true });
		for (const type of Object.values(SPACE_TYPES)) {
			expect(decide(type, banned, { channel: channel() }).authorized).toBe(false);
		}
	});

	it("refuses an unrecognised space type", () => {
		expect(
			decide("com.example.something", authz({ roles: [role({ protected: true })] })).authorized,
		).toBe(false);
	});
});
