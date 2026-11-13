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
	apply: ReturnType<typeof vi.fn>;
};
let voiceCommand: ReturnType<typeof vi.fn>;
let participant: ReturnType<typeof vi.fn>;
let grantMove: ReturnType<typeof vi.fn>;
let ctx: AppContext;

const moved = (destination: string) => {
	return { channel: GENERAL, subject: MEMBER, moveTo: destination };
};

beforeEach(() => {
	roster = {
		isJoined: vi.fn(() => true),
		apply: vi.fn(async () => {}),
	};
	voiceCommand = vi.fn();
	participant = vi.fn(async () => null);
	grantMove = vi.fn(async () => {});
	ctx = {
		nodeId: "node-a",
		announce: { voiceCommand },
		voiceCalls: { participant, grantMove },
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

describe("handleModerateVoice across nodes", () => {
	beforeEach(() => {
		ctx.voice = { presenceOf: () => undefined } as unknown as AppContext["voice"];
		roster.isJoined.mockReturnValue(false);
	});

	it("sends the command to the node hosting the call", async () => {
		participant.mockResolvedValue({ did: MEMBER, channel: GENERAL, nodeId: "node-b" });

		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, muted: true });

		expect(voiceCommand).toHaveBeenCalledWith("node-b", {
			channel: GENERAL,
			subject: MEMBER,
			muted: true,
		});
		expect(roster.apply).not.toHaveBeenCalled();
	});

	it("rejects a subject who is in no call on any node", async () => {
		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, disconnect: true }),
		).rejects.toMatchObject({ customErrorName: "NotInVoice" });
	});

	it("rejects a subject whose call is in another channel", async () => {
		participant.mockResolvedValue({ did: MEMBER, channel: LOUNGE, nodeId: "node-b" });

		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, disconnect: true }),
		).rejects.toMatchObject({ customErrorName: "NotInVoice" });
	});

	it("works on a node without voice when the call runs elsewhere", async () => {
		ctx.voice = null as unknown as AppContext["voice"];
		participant.mockResolvedValue({ did: MEMBER, channel: GENERAL, nodeId: "node-b" });

		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, disconnect: true });

		expect(voiceCommand).toHaveBeenCalledWith("node-b", {
			channel: GENERAL,
			subject: MEMBER,
			disconnect: true,
		});
	});
});

describe("handleModerateVoice moveTo", () => {
	it("moves the subject to another voice channel in the same space", async () => {
		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE });

		expect(roster.apply).toHaveBeenCalledWith(moved(LOUNGE));
	});

	it("does nothing when the destination is the current channel", async () => {
		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: GENERAL });

		expect(roster.apply).toHaveBeenCalledWith({ channel: GENERAL, subject: MEMBER });
	});

	it("rejects a destination in another space", async () => {
		await expect(
			handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: FOREIGN }),
		).rejects.toMatchObject({ customErrorName: "NotVoiceChannel" });
		expect(roster.apply).not.toHaveBeenCalled();
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
		expect(roster.apply).not.toHaveBeenCalled();
	});

	it("grants a call in a destination the subject cannot join on their own", async () => {
		channels.set(LOUNGE, channel(LOUNGE, "lounge", ["speakers"]));
		roster.apply.mockImplementation(async () => {
			expect(grantMove).toHaveBeenCalledWith(MEMBER, LOUNGE, MOD);
		});
		try {
			await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE });
		} finally {
			channels.set(LOUNGE, channel(LOUNGE, "lounge"));
		}

		expect(roster.apply).toHaveBeenCalledWith(moved(LOUNGE));
	});

	it("grants the call before the hosting node hears about the move", async () => {
		channels.set(LOUNGE, { ...channel(LOUNGE, "lounge"), visibleToRoles: ["staff"] });
		ctx.voice = { presenceOf: () => undefined } as unknown as AppContext["voice"];
		roster.isJoined.mockReturnValue(false);
		participant.mockResolvedValue({ did: MEMBER, channel: GENERAL, nodeId: "node-b" });
		voiceCommand.mockImplementation(() => {
			expect(grantMove).toHaveBeenCalledWith(MEMBER, LOUNGE, MOD);
		});
		try {
			await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE });
		} finally {
			channels.set(LOUNGE, channel(LOUNGE, "lounge"));
		}

		expect(voiceCommand).toHaveBeenCalledWith("node-b", moved(LOUNGE));
	});

	it("grants nothing when the subject may join the destination anyway", async () => {
		await handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE });

		expect(grantMove).not.toHaveBeenCalled();
	});

	it("grants nothing when the subject is not in the call", async () => {
		channels.set(LOUNGE, channel(LOUNGE, "lounge", ["speakers"]));
		roster.isJoined.mockReturnValue(false);
		ctx.voice = { presenceOf: () => undefined } as unknown as AppContext["voice"];
		try {
			await expect(
				handleModerateVoice(ctx, MOD, { channel: GENERAL, subject: MEMBER, moveTo: LOUNGE }),
			).rejects.toMatchObject({ customErrorName: "NotInVoice" });
		} finally {
			channels.set(LOUNGE, channel(LOUNGE, "lounge"));
		}

		expect(grantMove).not.toHaveBeenCalled();
	});

	it("rejects a move by someone without the permission", async () => {
		await expect(
			handleModerateVoice(ctx, MEMBER, { channel: GENERAL, subject: MOD, moveTo: LOUNGE }),
		).rejects.toMatchObject({ customErrorName: "Forbidden" });
	});
});
