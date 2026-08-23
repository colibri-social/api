import {
	COLLECTIONS,
	type CommunitySpaces,
	channelSpace,
	communitySpaces,
	PERMISSIONS,
	SELF,
	SPACE_TYPES,
	spaceUri,
} from "@colibri-social/lexicons";
import {
	managingAppPolicy,
	nextTid,
	openAppAccess,
	type PdsAdmin,
	type PdsClient,
	publicPolicy,
	type SpacePolicy,
} from "@colibri-social/space";
import type { CommunityCredentials, CommunityHost } from "./credentials.js";
import { generatePassword } from "./crypto.js";
import type { SpaceRegistry } from "./spaces.js";

export type ProvisionStep =
	| "verifyingCredentials"
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

export type AdoptRequest = {
	did: string;
	pdsEndpoint: string;
	identifier: string;
	password: string;
	name: string;
	description?: string;
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
	admin: PdsAdmin | null;
	credentials: CommunityCredentials;
	spaces: SpaceRegistry;
	handleDomain: string;
	appviewService: string;
	requiresInviteCode?: boolean;
	emailDomain?: string;
	now?: () => Date;
};

export class ProvisioningRefused extends Error {
	constructor(
		readonly reason: "identityMismatch" | "alreadyASpaceCommunity" | "adminUnavailable",
		message: string,
	) {
		super(message);
		this.name = "ProvisioningRefused";
	}
}

const TOTAL_STEPS = 5;

const COMMUNITY_SPACE_TYPES = [
	SPACE_TYPES.communityProfile,
	SPACE_TYPES.communityConfiguration,
	SPACE_TYPES.communityMembers,
	SPACE_TYPES.communityModeration,
] as const;

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

	private get appviewDid(): string {
		return this.deps.appviewService.split("#")[0] as string;
	}

	private policyFor(spaceType: string, isPrivate: boolean): SpacePolicy {
		if (spaceType === SPACE_TYPES.communityProfile && !isPrivate) return publicPolicy();
		return managingAppPolicy(this.deps.appviewService);
	}

	async create(
		request: ProvisionRequest,
		onProgress?: (progress: ProvisionProgress) => void,
	): Promise<ProvisionedCommunity> {
		const admin = this.deps.admin;
		if (!admin) {
			throw new ProvisioningRefused(
				"adminUnavailable",
				"no PDS admin password is configured, so accounts cannot be provisioned here",
			);
		}

		const report = (step: ProvisionStep, completed: number, community?: string) =>
			onProgress?.({ step, completed, total: TOTAL_STEPS, ...(community ? { community } : {}) });

		const handle = this.handleFor(request);
		const password = generatePassword();

		report("creatingAccount", 0);
		const inviteCode = this.deps.requiresInviteCode
			? (await admin.createInviteCode(1)).code
			: undefined;

		const account = await admin.createAccount({
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
		const seeded = await this.seed(
			{ pds: this.deps.pds, session },
			account.did,
			request,
			report,
			1,
		);

		return { did: account.did, handle, ...seeded };
	}

	async adopt(
		request: AdoptRequest,
		onProgress?: (progress: ProvisionProgress) => void,
	): Promise<ProvisionedCommunity> {
		const report = (step: ProvisionStep, completed: number, community?: string) =>
			onProgress?.({ step, completed, total: TOTAL_STEPS, ...(community ? { community } : {}) });

		report("verifyingCredentials", 0);
		const pds = this.deps.credentials.clientFor(request.pdsEndpoint);
		const session = await pds.login({
			identifier: request.identifier,
			password: request.password,
		});

		if (session.did !== request.did) {
			throw new ProvisioningRefused(
				"identityMismatch",
				`those credentials authenticate ${session.did}, not ${request.did}`,
			);
		}

		const spaces = communitySpaces(request.did);
		const { spaces: existing } = await pds.listSpaces(session);
		const taken = new Set(existing.map((space) => space.uri));
		if (Object.values(spaces).some((space) => taken.has(space))) {
			throw new ProvisioningRefused(
				"alreadyASpaceCommunity",
				`${request.did} already has community spaces, so it cannot be adopted again`,
			);
		}

		await this.deps.credentials.store({
			community: request.did,
			pdsEndpoint: request.pdsEndpoint,
			identifier: request.identifier,
			password: request.password,
			source: "registered",
		});

		const seeded = await this.seed({ pds, session }, request.did, request, report, 1);
		return { did: request.did, handle: session.handle, ...seeded };
	}

	private async seed(
		host: CommunityHost,
		community: string,
		request: { name: string; description?: string; creator: string; isPrivate?: boolean },
		report: (step: ProvisionStep, completed: number, community?: string) => void,
		completed: number,
	): Promise<Omit<ProvisionedCommunity, "did" | "handle">> {
		const spaces = communitySpaces(community);
		const isPrivate = request.isPrivate ?? false;

		report("creatingSpaces", completed, community);
		for (const spaceType of COMMUNITY_SPACE_TYPES) {
			await host.pds.createSpace(host.session, {
				type: spaceType,
				skey: SELF,
				policy: this.policyFor(spaceType, isPrivate),
				appAccess: openAppAccess(),
			});
			await this.deps.spaces.register({
				uri: spaceUri(community, spaceType, SELF),
				community,
				host: host.pds.service,
			});
		}

		report("writingProfile", completed + 1, community);
		await host.pds.putRecord(host.session, {
			space: spaces.profile,
			collection: COLLECTIONS.community,
			rkey: SELF,
			record: {
				$type: COLLECTIONS.community,
				name: request.name,
				managingApp: this.appviewDid,
				...(request.description ? { description: request.description } : {}),
			},
		});

		report("creatingOwnerRole", completed + 2, community);
		const ownerRole = nextTid();
		await host.pds.putRecord(host.session, {
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
		await host.pds.putRecord(host.session, {
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

		report("creatingStarterChannels", completed + 3, community);
		const channels = await this.seedLayout(host, community, spaces);

		report("done", TOTAL_STEPS, community);
		return { spaces, ownerRole, channels };
	}

	private handleFor(request: ProvisionRequest): string {
		const prefix = slugify(request.handlePrefix ?? request.name) || nextTid();
		return `${prefix}.${this.deps.handleDomain}`;
	}

	private async seedLayout(
		host: CommunityHost,
		community: string,
		spaces: CommunitySpaces,
	): Promise<{ text: string; voice: string }> {
		const text = await this.createChannel(host, community, {
			type: SPACE_TYPES.channelText,
			name: "general",
		});
		const voice = await this.createChannel(host, community, {
			type: SPACE_TYPES.channelVoice,
			name: "General",
		});

		const textCategory = nextTid();
		const voiceCategory = nextTid();
		await host.pds.putRecord(host.session, {
			space: spaces.configuration,
			collection: COLLECTIONS.category,
			rkey: textCategory,
			record: {
				$type: COLLECTIONS.category,
				name: "Text channels",
				channelOrder: [skeyOf(text)],
			},
		});
		await host.pds.putRecord(host.session, {
			space: spaces.configuration,
			collection: COLLECTIONS.category,
			rkey: voiceCategory,
			record: {
				$type: COLLECTIONS.category,
				name: "Voice channels",
				channelOrder: [skeyOf(voice)],
			},
		});
		await host.pds.putRecord(host.session, {
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
		host: CommunityHost,
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

		await host.pds.createSpace(host.session, {
			type: channel.type,
			skey,
			policy: managingAppPolicy(this.deps.appviewService),
			appAccess: openAppAccess(),
		});
		await this.deps.spaces.register({ uri: space, community, host: host.pds.service });

		await host.pds.putRecord(host.session, {
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

	async deleteChannel(host: CommunityHost, space: string): Promise<void> {
		await host.pds.deleteSpace(host.session, space);
		await this.deps.spaces.forget(space);
	}

	async destroy(community: string, host: CommunityHost, spaces: CommunitySpaces): Promise<void> {
		for (const space of Object.values(spaces)) {
			await host.pds.deleteSpace(host.session, space).catch(() => undefined);
			await this.deps.spaces.forget(space);
		}
		if (this.deps.admin && host.pds.service === this.deps.pds.service) {
			await this.deps.admin.deleteAccount(community);
		}
		await this.deps.credentials.forget(community);
	}
}

const skeyOf = (space: string): string => space.split("/").pop() as string;
