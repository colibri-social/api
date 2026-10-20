import type { ActorAuthz, ChannelState, RoleState } from "@colibri-social/community";
import { channelSpace, SPACE_TYPES } from "@colibri-social/lexicons";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { handleModerateVoice } from "./voice.js";

const COMMUNITY = "did:plc:community";
const OTHER_COMMUNITY = "did:plc:elsewhere";
const MOD = "did:plc:moderator";
const MEMBER = "did:plc:member";

const GENERAL = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "general");
const LOUNGE = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "lounge");
const STAGE = channelSpace(COMMUNITY, SPACE_TYPES.channelVoice, "stage");
const CHAT = channelSpace(COMMUNITY, SPACE_TYPES.channelText, "chat");
const FOREIGN = channelSpace(OTHER_COMMUNITY, SPACE_TYPES.channelVoice, "general");

const moderatorRole: RoleState = {
	rkey: "mods",
	name: "Mods",
	permissions: ["voice.moderate"],
	position: 1,
	hoisted: false,
	mentionable: false,
	protected: false,
	isDefault: false,
	channelOverrides: [{ channel: "stage", allow: [], deny: ["voice.moderate"] }],
};

const authzOf = (did: string, roles: RoleState[]): ActorAuthz => ({
	actor: did,
	community: COMMUNITY,
	isOwner: false,
	isBanned: false,
	member: {
		did,
		roles: roles.map((role) => role.rkey),
		joinedAt: "2026-01-01T00:00:00.000Z",
		nickname: null,
	},
	roles,
});

const channel = (space: string, skey: string, allowedRoles: string[] = []): ChannelState => ({
	space,
	skey,
	ownerOnly: false,
	allowedRoles,
	allowedMembers: [],
	visibleToRoles: [],
	visibleToMembers: [],
});

const channels = new Map<string, ChannelState>([
	[GENERAL, channel(GENERAL, "general")],
	[LOUNGE, channel(LOUNGE, "lounge")],
	[STAGE, channel(STAGE, "stage")],
	[CHAT, channel(CHAT, "chat")],
]);

let roster: {
	isJoined: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	move: ReturnType<typeof vi.fn>;
};
let ctx: AppContext;

beforeEach(() => {
	roster = {
		isJoined: vi.fn(() => true),
		disconnect: vi.fn(async () => {}),
		move: vi.fn(async () => {}),
	};
	ctx = {
		loader: {
			channel: async (space: string) => channels.get(space) ?? null,
			authz: async (_community: string, actor: string) =>
				actor === MOD ? authzOf(MOD, [moderatorRole]) : authzOf(actor, []),
		},
		voice: {
			presenceOf: () => GENERAL,
			moderate: vi.fn(async () => {}),
		},
		voiceRoster: roster,
	} as unknown as AppContext;
});

describe("handleModerateVoice moveTo", () => {
	it("moves the subject to another voice channel in the same space", async () => {
		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE });

		expect(roster.move).toHaveBeenCalledWith(GENERAL, MEMBER, LOUNGE);
	});

	it("does nothing when the destination is the current channel", async () => {
		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: GENERAL });

		expect(roster.move).not.toHaveBeenCalled();
	});

	it("rejects a destination in another space", async () => {
		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: FOREIGN }),
		).rejects.toMatchObject({ customErrorName: "NotVoiceChannel" });
		expect(roster.move).not.toHaveBeenCalled();
	});

	it("rejects a text channel as the destination", async () => {
		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: CHAT }),
		).rejects.toMatchObject({ customErrorName: "NotVoiceChannel" });
	});

	it("rejects a destination the moderator cannot moderate", async () => {
		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: STAGE }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
		expect(roster.move).not.toHaveBeenCalled();
	});

	it("rejects a destination the subject cannot speak in", async () => {
		channels.set(LOUNGE, channel(LOUNGE, "lounge", ["speakers"]));
		try {
			await expect(
				handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE }),
			).rejects.toMatchObject({ customErrorName: "DestinationForbidden" });
		} finally {
			channels.set(LOUNGE, channel(LOUNGE, "lounge"));
		}
	});

	it("rejects a move by someone without the permission", async () => {
		await expect(
			handleModerateVoice(ctx, MEMBER, { channel: GENERAL, subject: MOD, moveTo: LOUNGE }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});
