import { describe, expect, it } from "vitest";
import {
	type ActorAuthz,
	BASELINE_PERMISSIONS,
	type CategoryScope,
	type ChannelState,
	canPost,
	canRead,
	effectivePermissions,
	has,
	isPrivateChannel,
	isPrivateScope,
	type RoleState,
	voiceCapabilities,
	voicePermissionKeys,
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

const category = (overrides: Partial<CategoryScope> = {}): CategoryScope => ({
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
	baseline: BASELINE_PERMISSIONS,
	roles: roles.map((rkey) => ({
		rkey,
		name: rkey,
		permissions: [],
		position: 10,
		hoisted: false,
		mentionable: false,
		protected: false,
		isDefault: false,
		channelOverrides: [],
	})),
});

describe("category inheritance", () => {
	it("leaves a channel outside a category open", () => {
		expect(canRead(member("did:plc:b"), channel({ category: null }))).toBe(true);
	});

	it("makes an open channel in a private category private", () => {
		const state = channel({ category: category({ visibleToRoles: ["staff"] }) });
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(true);
		expect(canRead(member("did:plc:b"), state)).toBe(false);
	});

	it("lets a channel's own visibility override the category's", () => {
		const state = channel({
			visibleToMembers: ["did:plc:b"],
			category: category({ visibleToRoles: ["staff"] }),
		});
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(false);
		expect(canRead(member("did:plc:b"), state)).toBe(true);
	});

	it("inherits posting rules separately from visibility", () => {
		const state = channel({
			visibleToRoles: ["staff"],
			category: category({ allowedRoles: ["leads"] }),
		});
		expect(canRead(member("did:plc:a", ["staff"]), state)).toBe(true);
		expect(canPost(member("did:plc:a", ["staff"]), state)).toBe(false);
		expect(canPost(member("did:plc:c", ["staff", "leads"]), state)).toBe(true);
	});

	it("lets a channel's own posting rule override the category's", () => {
		const state = channel({
			allowedMembers: ["did:plc:a"],
			category: category({ ownerOnly: true }),
		});
		expect(canPost(member("did:plc:a"), state)).toBe(true);
	});

	it("reports a category as private only when it restricts reading", () => {
		expect(isPrivateScope(category({ ownerOnly: true }))).toBe(false);
		expect(isPrivateScope(category({ visibleToMembers: ["did:plc:a"] }))).toBe(true);
	});
});

describe("voice capabilities", () => {
	const ALL_VOICE = [
		"voice.speak",
		"voice.listen",
		"voice.camera",
		"voice.screenshare",
		"voice.chat",
	];

	const holder = (role: Partial<RoleState>): ActorAuthz => ({
		...member("did:plc:a"),
		roles: [
			{
				rkey: "members",
				name: "Members",
				permissions: ALL_VOICE,
				position: 0,
				hoisted: false,
				mentionable: false,
				protected: false,
				isDefault: true,
				channelOverrides: [],
				...role,
			},
		],
	});

	it("grants every capability the member's roles list", () => {
		expect(voiceCapabilities(holder({}), channel())).toEqual({
			speak: true,
			listen: true,
			camera: true,
			screenshare: true,
			chat: true,
		});
	});

	it("withholds every capability from a member with no roles", () => {
		expect(voicePermissionKeys(voiceCapabilities(member("did:plc:a"), channel()))).toEqual([]);
	});

	it("applies a channel override that denies a capability in that channel only", () => {
		const denied = holder({
			channelOverrides: [{ channel: "general", allow: [], deny: ["voice.speak", "voice.camera"] }],
		});

		expect(voicePermissionKeys(voiceCapabilities(denied, channel()))).toEqual([
			"voice.listen",
			"voice.screenshare",
			"voice.chat",
		]);
		expect(voiceCapabilities(denied, channel({ skey: "lounge" })).speak).toBe(true);
	});

	it("applies a channel override that allows a capability the role lacks", () => {
		const allowed = holder({
			permissions: [],
			channelOverrides: [{ channel: "general", allow: ["voice.chat"], deny: [] }],
		});

		expect(voicePermissionKeys(voiceCapabilities(allowed, channel()))).toEqual(["voice.chat"]);
	});

	it("grants an admin every capability whatever the overrides say", () => {
		const admin = holder({
			protected: true,
			permissions: [],
			channelOverrides: [{ channel: "general", allow: [], deny: ALL_VOICE }],
		});

		expect(voicePermissionKeys(voiceCapabilities(admin, channel()))).toEqual(ALL_VOICE);
	});
});

describe("permission overrides", () => {
	const role = (
		rkey: string,
		position: number,
		permissions: string[],
		isDefault = false,
	): RoleState => ({
		rkey,
		name: rkey,
		permissions,
		position,
		hoisted: false,
		mentionable: false,
		protected: false,
		isDefault,
		channelOverrides: [],
	});

	const everyone = role("everyone", 0, [...BASELINE_PERMISSIONS, "voice.speak"], true);
	const mods = role("mods", 3, ["thread.manage"]);
	const admins = role("admins", 5, []);

	const holder = (did: string, ...roles: RoleState[]): ActorAuthz => ({
		actor: did,
		community: COMMUNITY,
		isOwner: false,
		isBanned: false,
		member: {
			did,
			roles: roles.map((entry) => entry.rkey),
			joinedAt: "2026-10-01T00:00:00.000Z",
			nickname: null,
		},
		roles,
	});

	const readOnly = channel({
		overrides: [
			{ role: "everyone", allow: [], deny: ["message.send"] },
			{ role: "admins", allow: ["message.send"], deny: [] },
		],
	});

	it("lets a higher role's Allow beat the default role's Deny", () => {
		expect(canPost(holder("did:plc:a", everyone), readOnly)).toBe(false);
		expect(canPost(holder("did:plc:b", everyone, admins), readOnly)).toBe(true);
	});

	it("lets a higher role's Deny beat a lower role's Allow", () => {
		const state = channel({
			overrides: [
				{ role: "mods", allow: ["message.send"], deny: [] },
				{ role: "admins", allow: [], deny: ["message.send"] },
			],
		});

		expect(canPost(holder("did:plc:a", everyone, mods), state)).toBe(true);
		expect(canPost(holder("did:plc:b", everyone, mods, admins), state)).toBe(false);
	});

	it("lets a member override beat every role override", () => {
		const state = channel({
			overrides: [
				{ role: "everyone", allow: [], deny: ["message.send"] },
				{ role: "admins", allow: ["message.send"], deny: [] },
				{ member: "did:plc:a", allow: ["message.send"], deny: [] },
				{ member: "did:plc:b", allow: [], deny: ["message.send"] },
			],
		});

		expect(canPost(holder("did:plc:a", everyone), state)).toBe(true);
		expect(canPost(holder("did:plc:b", everyone, admins), state)).toBe(false);
	});

	it("lets the channel's answer beat the category's", () => {
		const state = channel({
			overrides: [{ role: "everyone", allow: ["channel.view"], deny: [] }],
			category: category({
				overrides: [{ role: "everyone", allow: [], deny: ["channel.view", "message.send"] }],
			}),
		});

		expect(canRead(holder("did:plc:a", everyone), state)).toBe(true);
		expect(canPost(holder("did:plc:a", everyone), state)).toBe(false);
	});

	it("falls through Inherit to the category, then to the role permissions", () => {
		const state = channel({
			overrides: [],
			category: category({
				overrides: [{ role: "everyone", allow: [], deny: ["voice.speak"] }],
			}),
		});

		expect(has(holder("did:plc:a", everyone), "voice.speak", state)).toBe(false);
		expect(has(holder("did:plc:a", everyone), "message.send", state)).toBe(true);
		expect(has(holder("did:plc:a", everyone), "thread.manage", state)).toBe(false);
		expect(has(holder("did:plc:b", everyone, mods), "thread.manage", state)).toBe(true);
	});

	it("withholds every other permission in a channel the member can't view", () => {
		const state = channel({
			overrides: [{ role: "everyone", allow: ["message.send"], deny: ["channel.view"] }],
		});

		expect(effectivePermissions(holder("did:plc:a", everyone), state)).toEqual([]);
	});

	it("keeps voice capabilities for a member admitted through a move grant", () => {
		const hidden = channel({
			voice: true,
			overrides: [{ role: "everyone", allow: [], deny: ["channel.view"] }],
		});

		expect(has(holder("did:plc:a", everyone), "voice.speak", hidden)).toBe(false);
		expect(has(holder("did:plc:a", everyone), "voice.speak", hidden, { admitted: true })).toBe(
			true,
		);
	});

	it("ignores the legacy audience once a scope has overrides", () => {
		const state = channel({ overrides: [], visibleToRoles: ["staff"], ownerOnly: true });

		expect(canRead(holder("did:plc:a", everyone), state)).toBe(true);
		expect(canPost(holder("did:plc:a", everyone), state)).toBe(true);
	});

	it("needs channel.view and the posting key from the role permissions", () => {
		const bare = role("everyone", 0, [], true);

		expect(canRead(holder("did:plc:a", bare), channel({ overrides: [] }))).toBe(false);
		expect(canPost(holder("did:plc:a", everyone), channel({ overrides: [], voice: true }))).toBe(
			true,
		);
	});

	it("gives the owner and owner-role holders everything and banned members nothing", () => {
		const locked = channel({
			overrides: [{ role: "everyone", allow: [], deny: ["channel.view"] }],
		});
		const owners = { ...role("owners", 9, []), protected: true };

		expect(canPost({ ...holder("did:plc:a"), isOwner: true }, locked)).toBe(true);
		expect(canPost(holder("did:plc:b", everyone, owners), locked)).toBe(true);
		expect(canRead({ ...holder("did:plc:c", everyone), isBanned: true }, channel())).toBe(false);
	});

	it("marks a channel private when the default role is denied channel.view", () => {
		const hiddenCategory = category({
			overrides: [{ role: "everyone", allow: [], deny: ["channel.view"] }],
		});

		expect(isPrivateChannel(channel({ overrides: [] }), "everyone")).toBe(false);
		expect(isPrivateChannel(channel({ overrides: [], category: hiddenCategory }), "everyone")).toBe(
			true,
		);
		expect(
			isPrivateChannel(
				channel({
					overrides: [{ role: "everyone", allow: ["channel.view"], deny: [] }],
					category: hiddenCategory,
				}),
				"everyone",
			),
		).toBe(false);
		expect(isPrivateScope(hiddenCategory, "everyone")).toBe(true);
	});
});
