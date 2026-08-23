import {
	COLLECTIONS,
	type CommunitySpaces,
	channelSpace,
	communitySpaces,
	PERMISSIONS,
	SELF,
	SPACE_TYPES,
} from "@colibri-social/lexicons";
import {
	managingAppPolicy,
	nextTid,
	openAppAccess,
	type PdsAdmin,
	type PdsClient,
	type PdsSession,
	publicPolicy,
	type SpacePolicy,
} from "@colibri-social/space";
import type { CommunityCredentials } from "./credentials.js";
import { generatePassword } from "./crypto.js";

export type ProvisionStep =
	| "creatingAccount"
	| "creatingSpaces"
	| "writingProfile"
	| "creatingOwnerRole"
	| "creatingStarterChannels"
	| "done"
	| "failed";

export type ProvisionProgress = {
	step: ProvisionStep;
	completed: number;
	total: number;
	community?: string;
	message?: string;
};

export type ProvisionRequest = {
	name: string;
	description?: string;
	handlePrefix?: string;
	creator: string;
	isPrivate?: boolean;
};

export type ProvisionedCommunity = {
	did: string;
	handle: string;
	spaces: CommunitySpaces;
	ownerRole: string;
	channels: { text: string; voice: string };
};

export type ProvisionerDeps = {
	pds: PdsClient;
	admin: PdsAdmin;
	credentials: CommunityCredentials;
	handleDomain: string;
	appviewService: string;
	requiresInviteCode?: boolean;
	emailDomain?: string;
	now?: () => Date;
};

const TOTAL_STEPS = 5;

const slugify = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);

export class CommunityProvisioner {
	private readonly now: () => Date;

	constructor(private readonly deps: ProvisionerDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	private policyFor(spaceType: string, isPrivate: boolean): SpacePolicy {
		if (spaceType === SPACE_TYPES.communityProfile && !isPrivate) return publicPolicy();
		return managingAppPolicy(this.deps.appviewService);
	}

	async create(
		request: ProvisionRequest,
		onProgress?: (progress: ProvisionProgress) => void,
	): Promise<ProvisionedCommunity> {
		const report = (step: ProvisionStep, completed: number, community?: string) =>
			onProgress?.({ step, completed, total: TOTAL_STEPS, ...(community ? { community } : {}) });

		const handle = this.handleFor(request);
		const password = generatePassword();

		report("creatingAccount", 0);
		const inviteCode = this.deps.requiresInviteCode
			? (await this.deps.admin.createInviteCode(1)).code
			: undefined;

		const account = await this.deps.admin.createAccount({
			handle,
			email: `${handle.split(".")[0]}@${this.deps.emailDomain ?? this.deps.handleDomain}`,
			password,
			...(inviteCode ? { inviteCode } : {}),
		});

		await this.deps.credentials.store({
			community: account.did,
			pdsEndpoint: this.deps.pds.service,
			identifier: handle,
			password,
			source: "provisioned",
		});

		const session = await this.deps.pds.login({ identifier: handle, password });
		const spaces = communitySpaces(account.did);
		const isPrivate = request.isPrivate ?? false;

		report("creatingSpaces", 1, account.did);
		for (const spaceType of [
			SPACE_TYPES.communityProfile,
			SPACE_TYPES.communityConfiguration,
			SPACE_TYPES.communityMembers,
			SPACE_TYPES.communityModeration,
		]) {
			await this.deps.pds.createSpace(session, {
				type: spaceType,
				skey: SELF,
				policy: this.policyFor(spaceType, isPrivate),
				appAccess: openAppAccess(),
			});
		}

		report("writingProfile", 2, account.did);
		await this.deps.pds.putRecord(session, {
			space: spaces.profile,
			collection: COLLECTIONS.community,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.community,
				name: request.name,
				...(request.description ? { description: request.description } : {}),
			},
		});

		report("creatingOwnerRole", 3, account.did);
		const ownerRole = nextTid();
		await this.deps.pds.putRecord(session, {
			space: spaces.members,
			collection: COLLECTIONS.role,
			rkey: ownerRole,
			record: {
				$type: COLLECTIONS.role,
				name: "Owner",
				permissions: [...PERMISSIONS],
				position: 1000,
				hoisted: true,
				protected: true,
			},
		});
		await this.deps.pds.putRecord(session, {
			space: spaces.members,
			collection: COLLECTIONS.member,
			rkey: request.creator,
			record: {
				$type: COLLECTIONS.member,
				subject: request.creator,
				roles: [ownerRole],
				joinedAt: this.now().toISOString(),
			},
		});

		report("creatingStarterChannels", 4, account.did);
		const channels = await this.seedLayout(session, account.did, spaces);

		report("done", TOTAL_STEPS, account.did);
		return { did: account.did, handle, spaces, ownerRole, channels };
	}

	private handleFor(request: ProvisionRequest): string {
		const prefix = slugify(request.handlePrefix ?? request.name) || nextTid();
		return `${prefix}.${this.deps.handleDomain}`;
	}

	private async seedLayout(
		session: PdsSession,
		community: string,
		spaces: CommunitySpaces,
	): Promise<{ text: string; voice: string }> {
		const text = await this.createChannel(session, community, {
			type: SPACE_TYPES.channelText,
			name: "general",
		});
		const voice = await this.createChannel(session, community, {
			type: SPACE_TYPES.channelVoice,
			name: "General",
		});

		const textCategory = nextTid();
		const voiceCategory = nextTid();
		await this.deps.pds.putRecord(session, {
			space: spaces.configuration,
			collection: COLLECTIONS.category,
			rkey: textCategory,
			record: {
				$type: COLLECTIONS.category,
				name: "Text channels",
				channelOrder: [skeyOf(text)],
			},
		});
		await this.deps.pds.putRecord(session, {
			space: spaces.configuration,
			collection: COLLECTIONS.category,
			rkey: voiceCategory,
			record: {
				$type: COLLECTIONS.category,
				name: "Voice channels",
				channelOrder: [skeyOf(voice)],
			},
		});
		await this.deps.pds.putRecord(session, {
			space: spaces.configuration,
			collection: COLLECTIONS.communitySettings,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.communitySettings,
				categoryOrder: [textCategory, voiceCategory],
				requiresApprovalToJoin: false,
				linkEmbeds: true,
			},
		});

		return { text, voice };
	}

	async createChannel(
		session: PdsSession,
		community: string,
		channel: {
			type: string;
			name: string;
			description?: string;
			ownerOnly?: boolean;
			allowedRoles?: string[];
			allowedMembers?: string[];
			visibleToRoles?: string[];
			visibleToMembers?: string[];
		},
	): Promise<string> {
		const skey = nextTid();
		const space = channelSpace(community, channel.type as never, skey);

		await this.deps.pds.createSpace(session, {
			type: channel.type,
			skey,
			policy: managingAppPolicy(this.deps.appviewService),
			appAccess: openAppAccess(),
		});

		await this.deps.pds.putRecord(session, {
			space,
			collection: COLLECTIONS.channel,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.channel,
				name: channel.name,
				...(channel.description ? { description: channel.description } : {}),
				...(channel.ownerOnly ? { ownerOnly: true } : {}),
				...(channel.allowedRoles?.length ? { allowedRoles: channel.allowedRoles } : {}),
				...(channel.allowedMembers?.length ? { allowedMembers: channel.allowedMembers } : {}),
				...(channel.visibleToRoles?.length ? { visibleToRoles: channel.visibleToRoles } : {}),
				...(channel.visibleToMembers?.length ? { visibleToMembers: channel.visibleToMembers } : {}),
			},
		});

		return space;
	}

	async deleteChannel(session: PdsSession, space: string): Promise<void> {
		await this.deps.pds.deleteSpace(session, space);
	}

	async destroy(community: string, session: PdsSession, spaces: CommunitySpaces): Promise<void> {
		for (const space of Object.values(spaces)) {
			await this.deps.pds.deleteSpace(session, space).catch(() => undefined);
		}
		await this.deps.admin.deleteAccount(community);
		await this.deps.credentials.forget(community);
	}
}

const skeyOf = (space: string): string => space.split("/").pop() as string;
