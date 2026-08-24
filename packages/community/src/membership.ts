import type { Queryable, Schema } from "@colibri-social/appview-db";
import { COLLECTIONS } from "@colibri-social/lexicons";
import { and, eq } from "drizzle-orm";
import { isAdmin, outranks } from "./authz.js";
import type { CommunityLoader } from "./loader.js";
import type { CommunityWriter } from "./writes.js";

export type MembershipFailure =
	| "communityNotFound"
	| "alreadyMember"
	| "banned"
	| "invitationNotFound"
	| "notMember"
	| "soleOwner"
	| "applicationNotFound"
	| "roleNotFound"
	| "hierarchy";

export class MembershipError extends Error {
	constructor(
		readonly failure: MembershipFailure,
		message: string,
	) {
		super(message);
		this.name = "MembershipError";
	}
}

export type MembershipDeps = {
	db: Queryable;
	tables: Schema;
	loader: CommunityLoader;
	writer: CommunityWriter;
	now?: () => Date;
};

export type JoinOutcome = { status: "joined" } | { status: "pending" };

export class Membership {
	private readonly now: () => Date;

	constructor(private readonly deps: MembershipDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	private async redeemInvitation(community: string, code: string): Promise<void> {
		const [invitation] = await this.deps.db
			.select()
			.from(this.deps.tables.invitations)
			.where(eq(this.deps.tables.invitations.code, code))
			.limit(1);

		const usable =
			invitation &&
			invitation.community === community &&
			invitation.active &&
			(invitation.maxUses === null || invitation.uses < invitation.maxUses) &&
			(invitation.expiresAt === null || new Date(invitation.expiresAt) > this.now());

		if (!usable) {
			throw new MembershipError("invitationNotFound", "that invitation cannot be redeemed");
		}

		await this.deps.db
			.update(this.deps.tables.invitations)
			.set({ uses: invitation.uses + 1 })
			.where(eq(this.deps.tables.invitations.code, code));
	}

	async join(community: string, actor: string, invitation?: string): Promise<JoinOutcome> {
		const row = await this.deps.loader.community(community);
		if (!row) throw new MembershipError("communityNotFound", `no community at ${community}`);

		const authz = await this.deps.loader.authz(community, actor);
		if (authz.isBanned) throw new MembershipError("banned", "you are banned from this community");
		if (authz.member) throw new MembershipError("alreadyMember", "you are already a member");

		if (invitation) await this.redeemInvitation(community, invitation);

		if (row.requiresApproval && !invitation) {
			await this.deps.db
				.insert(this.deps.tables.applications)
				.values({ community, did: actor, createdAt: this.now().toISOString(), dismissedAt: null })
				.onConflictDoNothing();
			return { status: "pending" };
		}

		await this.admit(community, actor);
		return { status: "joined" };
	}

	async admit(community: string, subject: string, roles: string[] = []): Promise<void> {
		await this.deps.writer.put(community, {
			space: this.deps.writer.spaces(community).members,
			collection: COLLECTIONS.member,
			rkey: subject,
			record: {
				$type: COLLECTIONS.member,
				subject,
				roles,
				joinedAt: this.now().toISOString(),
			},
		});
		await this.deps.db
			.delete(this.deps.tables.applications)
			.where(
				and(
					eq(this.deps.tables.applications.community, community),
					eq(this.deps.tables.applications.did, subject),
				),
			);
	}

	async approve(community: string, subject: string): Promise<void> {
		const [application] = await this.deps.db
			.select()
			.from(this.deps.tables.applications)
			.where(
				and(
					eq(this.deps.tables.applications.community, community),
					eq(this.deps.tables.applications.did, subject),
				),
			)
			.limit(1);
		if (!application) {
			throw new MembershipError("applicationNotFound", `${subject} has not applied to join`);
		}
		await this.admit(community, subject);
	}

	async dismiss(community: string, subject: string, dismissed: boolean): Promise<void> {
		const updated = await this.deps.db
			.update(this.deps.tables.applications)
			.set({ dismissedAt: dismissed ? this.now().toISOString() : null })
			.where(
				and(
					eq(this.deps.tables.applications.community, community),
					eq(this.deps.tables.applications.did, subject),
				),
			)
			.returning({ did: this.deps.tables.applications.did });

		if (updated.length === 0)
			throw new MembershipError("applicationNotFound", `${subject} has not applied to join`);
	}

	private async assertNotSoleOwner(community: string, subject: string): Promise<void> {
		const authz = await this.deps.loader.authz(community, subject);
		if (!isAdmin(authz)) return;

		const protectedRoles = new Set(
			(await this.deps.loader.roles(community)).filter((role) => role.protected).map((r) => r.rkey),
		);
		const members = await this.deps.db
			.select()
			.from(this.deps.tables.members)
			.where(eq(this.deps.tables.members.community, community));

		const otherAdmins = members.filter(
			(member) => member.did !== subject && member.roles.some((rkey) => protectedRoles.has(rkey)),
		);
		if (otherAdmins.length === 0) {
			throw new MembershipError(
				"soleOwner",
				"you are the only administrator, so transfer the community before leaving",
			);
		}
	}

	async leave(community: string, actor: string): Promise<void> {
		const authz = await this.deps.loader.authz(community, actor);
		if (!authz.member) throw new MembershipError("notMember", "you are not a member");
		await this.assertNotSoleOwner(community, actor);
		await this.remove(community, actor);
	}

	async kick(community: string, actor: string, subject: string): Promise<void> {
		const [acting, target] = await Promise.all([
			this.deps.loader.authz(community, actor),
			this.deps.loader.authz(community, subject),
		]);
		if (!target.member) throw new MembershipError("notMember", `${subject} is not a member`);
		if (!outranks(acting, target)) {
			throw new MembershipError("hierarchy", "you do not outrank that member");
		}
		await this.remove(community, subject);
	}

	async remove(community: string, subject: string): Promise<void> {
		await this.deps.writer.remove(community, {
			space: this.deps.writer.spaces(community).members,
			collection: COLLECTIONS.member,
			rkey: subject,
		});
	}

	async setRoles(
		community: string,
		actor: string,
		subject: string,
		roles: string[],
	): Promise<void> {
		const [acting, target] = await Promise.all([
			this.deps.loader.authz(community, actor),
			this.deps.loader.authz(community, subject),
		]);
		if (!target.member) throw new MembershipError("notMember", `${subject} is not a member`);
		if (subject !== actor && !outranks(acting, target)) {
			throw new MembershipError("hierarchy", "you do not outrank that member");
		}

		const known = await this.deps.loader.roles(community);
		const byKey = new Map(known.map((role) => [role.rkey, role]));
		const touched = [...new Set([...roles, ...target.member.roles])].filter(
			(rkey) => !roles.includes(rkey) || !target.member?.roles.includes(rkey),
		);
		for (const rkey of touched) {
			const role = byKey.get(rkey);
			if (!role) throw new MembershipError("roleNotFound", `no role ${rkey} in this community`);
			if (!acting.isOwner && !outranksPositionOf(acting, role.position)) {
				throw new MembershipError("hierarchy", `you do not outrank the role ${role.name}`);
			}
		}

		await this.deps.writer.put(community, {
			space: this.deps.writer.spaces(community).members,
			collection: COLLECTIONS.member,
			rkey: subject,
			record: {
				$type: COLLECTIONS.member,
				subject,
				roles,
				joinedAt: target.member.joinedAt,
				...(target.member.nickname ? { nickname: target.member.nickname } : {}),
			},
		});
	}
}

const outranksPositionOf = (
	authz: { isOwner: boolean; roles: Array<{ position: number }> },
	position: number,
): boolean => {
	if (authz.isOwner) return true;
	if (authz.roles.length === 0) return false;
	return Math.max(...authz.roles.map((role) => role.position)) > position;
};
