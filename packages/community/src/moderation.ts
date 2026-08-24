import type { Queryable, Schema } from "@colibri-social/appview-db";
import { COLLECTIONS, type LabelValue } from "@colibri-social/lexicons";
import { and, desc, eq } from "drizzle-orm";
import { outranks } from "./authz.js";
import type { CommunityLoader } from "./loader.js";
import type { Membership } from "./membership.js";
import type { CommunityWriter } from "./writes.js";

export type ModerationFailure =
	| "notMember"
	| "hierarchy"
	| "alreadyBanned"
	| "notBanned"
	| "labelNotFound";

export type LoggedAction = {
	rkey: string;
	action: "ban" | "unban" | "kick";
	createdAt: string;
};

export class ModerationError extends Error {
	constructor(
		readonly failure: ModerationFailure,
		message: string,
	) {
		super(message);
		this.name = "ModerationError";
	}
}

export type ModerationDeps = {
	db: Queryable;
	tables: Schema;
	loader: CommunityLoader;
	writer: CommunityWriter;
	membership: Membership;
	now?: () => Date;
};

export type LabelSubject = {
	did: string;
	collection: string;
	rkey: string;
};

export class Moderation {
	private readonly now: () => Date;

	constructor(private readonly deps: ModerationDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	private async log(
		community: string,
		action: "ban" | "unban" | "kick",
		subject: string,
		createdBy: string,
		reason?: string,
	): Promise<LoggedAction> {
		const createdAt = this.now().toISOString();
		const { rkey } = await this.deps.writer.put(community, {
			space: this.deps.writer.spaces(community).moderation,
			collection: COLLECTIONS.moderation,
			record: {
				$type: COLLECTIONS.moderation,
				action,
				subject,
				createdBy,
				createdAt,
				...(reason ? { reason } : {}),
			},
		});
		return { rkey, action, createdAt };
	}

	private async assertOutranks(community: string, actor: string, subject: string): Promise<void> {
		const [acting, target] = await Promise.all([
			this.deps.loader.authz(community, actor),
			this.deps.loader.authz(community, subject),
		]);
		if (!outranks(acting, target)) {
			throw new ModerationError("hierarchy", "you do not outrank that member");
		}
	}

	async kick(
		community: string,
		actor: string,
		subject: string,
		reason?: string,
	): Promise<LoggedAction> {
		await this.deps.membership.kick(community, actor, subject);
		return this.log(community, "kick", subject, actor, reason);
	}

	async ban(
		community: string,
		actor: string,
		subject: string,
		reason?: string,
	): Promise<LoggedAction> {
		if (await this.deps.loader.isBanned(community, subject)) {
			throw new ModerationError("alreadyBanned", `${subject} is already banned`);
		}
		await this.assertOutranks(community, actor, subject);

		const target = await this.deps.loader.authz(community, subject);
		if (target.member) await this.deps.membership.remove(community, subject);
		return this.log(community, "ban", subject, actor, reason);
	}

	async unban(
		community: string,
		actor: string,
		subject: string,
		reason?: string,
	): Promise<LoggedAction> {
		if (!(await this.deps.loader.isBanned(community, subject))) {
			throw new ModerationError("notBanned", `${subject} is not banned`);
		}
		return this.log(community, "unban", subject, actor, reason);
	}

	async listBans(community: string, options: { limit?: number; cursor?: string } = {}) {
		const limit = options.limit ?? 50;
		const entries = await this.deps.db
			.select()
			.from(this.deps.tables.moderationLog)
			.where(eq(this.deps.tables.moderationLog.community, community))
			.orderBy(desc(this.deps.tables.moderationLog.rkey));

		const latest = new Map<string, (typeof entries)[number]>();
		for (const entry of entries) {
			if (entry.action === "kick") continue;
			if (!latest.has(entry.subject)) latest.set(entry.subject, entry);
		}

		const banned = [...latest.values()].filter((entry) => entry.action === "ban");
		const start = options.cursor
			? banned.findIndex((entry) => entry.rkey === options.cursor) + 1
			: 0;
		const page = banned.slice(start, start + limit);

		return {
			bans: page,
			cursor: start + limit < banned.length ? page.at(-1)?.rkey : undefined,
		};
	}

	async applyLabel(
		community: string,
		space: string,
		subject: LabelSubject,
		val: LabelValue | string,
		options: { scope?: string[]; reason?: string } = {},
	): Promise<{ rkey: string }> {
		const { rkey } = await this.deps.writer.put(community, {
			space,
			collection: COLLECTIONS.label,
			record: {
				$type: COLLECTIONS.label,
				subject,
				val,
				createdAt: this.now().toISOString(),
				...(options.scope?.length ? { scope: options.scope } : {}),
				...(options.reason ? { reason: options.reason } : {}),
			},
		});
		return { rkey };
	}

	async negateLabel(
		community: string,
		space: string,
		subject: LabelSubject,
		val: string,
		reason?: string,
	): Promise<void> {
		const [existing] = await this.deps.db
			.select()
			.from(this.deps.tables.labels)
			.where(
				and(
					eq(this.deps.tables.labels.space, space),
					eq(this.deps.tables.labels.src, community),
					eq(this.deps.tables.labels.subjectDid, subject.did),
					eq(this.deps.tables.labels.subjectRkey, subject.rkey),
					eq(this.deps.tables.labels.val, val),
					eq(this.deps.tables.labels.negated, false),
				),
			)
			.limit(1);

		if (!existing) {
			throw new ModerationError("labelNotFound", `no ${val} label from this community to retract`);
		}

		await this.deps.writer.put(community, {
			space,
			collection: COLLECTIONS.label,
			record: {
				$type: COLLECTIONS.label,
				subject,
				val,
				neg: true,
				createdAt: this.now().toISOString(),
				...(reason ? { reason } : {}),
			},
		});
	}
}
