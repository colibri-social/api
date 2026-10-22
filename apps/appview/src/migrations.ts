import {
	CommunityCredentialError,
	isMigrationStep,
	MIGRATION_STEPS,
	type MigrationProgress,
	type MigrationStep,
	migrateCommunity,
	migrationProgress,
} from "@colibri-social/community";
import { SERVICE_FRAGMENTS, serviceId } from "@colibri-social/identity";
import { eq } from "drizzle-orm";
import { communityProgressEvent } from "./announce.js";
import type { AppContext } from "./context.js";
import { backfillDefaultRole } from "./heal.js";
import { seedReadCursorsOnJoin } from "./routes/read-cursors.js";

export type MigrationState = "running" | "failed" | "done";

export type MigrationRow = {
	community: string;
	target: string | null;
	requestedBy: string;
	state: MigrationState;
	step: MigrationStep;
	completedSteps: MigrationStep[];
	error: string | null;
	startedAt: string;
	updatedAt: string;
	finishedAt: string | null;
};

const INDEX_ATTEMPTS = 20;
const INDEX_POLL_MS = 500;

const asState = (value: string): MigrationState =>
	value === "done" || value === "failed" ? value : "running";

export const progressOf = (row: MigrationRow): MigrationProgress & { failed?: boolean } => ({
	...migrationProgress(row.community, row.step),
	completed: row.completedSteps.filter((step) => step !== "done").length,
	...(row.state === "failed" ? { failed: true } : {}),
});

export class MigrationJobs {
	private readonly running = new Map<string, Promise<void>>();

	constructor(private readonly ctx: AppContext) {}

	private get table() {
		return this.ctx.database.tables.communityMigrations;
	}

	async get(community: string): Promise<MigrationRow | null> {
		const [row] = await this.ctx.database.db
			.select()
			.from(this.table)
			.where(eq(this.table.community, community))
			.limit(1);
		return row ? this.toRow(row) : null;
	}

	async all(communities: readonly string[]): Promise<Map<string, MigrationRow>> {
		const out = new Map<string, MigrationRow>();
		for (const community of communities) {
			const row = await this.get(community);
			if (row) out.set(community, row);
		}
		return out;
	}

	isRunning(community: string): boolean {
		return this.running.has(community);
	}

	async start(community: string, requestedBy: string): Promise<MigrationRow> {
		const existing = await this.get(community);
		if (existing?.state === "done") return existing;
		if (this.running.has(community) && existing) return existing;

		const now = new Date().toISOString();
		if (existing) {
			await this.ctx.database.db
				.update(this.table)
				.set({ state: "running", error: null, updatedAt: now })
				.where(eq(this.table.community, community));
		} else {
			await this.ctx.database.db.insert(this.table).values({
				community,
				requestedBy,
				state: "running",
				step: MIGRATION_STEPS[0],
				completedSteps: [],
				startedAt: now,
				updatedAt: now,
			});
		}

		this.launch(community);
		return (await this.get(community)) as MigrationRow;
	}

	async resume(): Promise<void> {
		const rows = await this.ctx.database.db
			.select()
			.from(this.table)
			.where(eq(this.table.state, "running"));
		for (const row of rows) {
			this.ctx.log.info({ community: row.community, step: row.step }, "migration.resume");
			this.launch(row.community);
		}
	}

	private launch(community: string): void {
		if (this.running.has(community)) return;
		const job = this.run(community).finally(() => this.running.delete(community));
		this.running.set(community, job);
	}

	private toRow(row: typeof this.table.$inferSelect): MigrationRow {
		return {
			community: row.community,
			target: row.target,
			requestedBy: row.requestedBy,
			state: asState(row.state),
			step: isMigrationStep(row.step) ? row.step : MIGRATION_STEPS[0],
			completedSteps: (row.completedSteps ?? []).filter(isMigrationStep),
			error: row.error,
			startedAt: row.startedAt,
			updatedAt: row.updatedAt,
			finishedAt: row.finishedAt,
		};
	}

	private async record(community: string, patch: Partial<typeof this.table.$inferInsert>) {
		await this.ctx.database.db
			.update(this.table)
			.set({ ...patch, updatedAt: new Date().toISOString() })
			.where(eq(this.table.community, community));
	}

	private async run(community: string): Promise<void> {
		const row = await this.get(community);
		if (!row) return;
		const completed = new Set<MigrationStep>(row.completedSteps);
		const announce = (
			progress: Omit<MigrationProgress, "step"> & { step: string },
			message?: string,
		) =>
			this.ctx.announce.toUser(
				row.requestedBy,
				communityProgressEvent({ ...progress, ...(message ? { message } : {}) }),
			);

		try {
			const target = row.target ?? (await this.resolveTarget(community));
			const report = await migrateCommunity(
				{
					database: this.ctx.database,
					hostFor: (did) => this.ctx.hosts.hostFor(did),
					credentials: this.ctx.credentials,
					writer: this.ctx.writer,
					spaces: this.ctx.spaces,
					appviewService: serviceId(this.ctx.config.APPVIEW_DID, SERVICE_FRAGMENTS.appview),
					log: (message, detail) => this.ctx.log.info({ community, ...detail }, message),
					completed,
					target,
					onProgress: (progress) => {
						if (progress.step === "done") return;
						void this.record(community, { step: progress.step });
						announce({ ...progress, completed: completed.size });
					},
					onStepDone: async (step) => {
						completed.add(step);
						await this.record(community, { completedSteps: [...completed] });
					},
				},
				community,
			);

			await this.finalize(target);

			const finishedAt = new Date().toISOString();
			await this.record(community, {
				state: "done",
				step: "done",
				completedSteps: [...MIGRATION_STEPS],
				report,
				finishedAt,
			});
			for (const warning of report.warnings) {
				this.ctx.log.warn({ community, warning }, "migration.warning");
			}
			this.ctx.log.info(
				{
					community,
					channels: report.channels,
					members: report.members,
					bans: report.bans,
					legacyMessages: report.legacyMessages,
				},
				"migration.done",
			);
			announce(migrationProgress(community, "done"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.log.error({ community, err: error }, "migration.failed");
			await this.record(community, { state: "failed", error: message });
			announce(
				{ ...migrationProgress(community, row.step), step: "failed" },
				"The move stopped partway. Start it again to continue where it left off.",
			);
		}
	}

	private async resolveTarget(community: string): Promise<string> {
		const target = await this.ctx.credentials
			.connect(community)
			.then(() => community)
			.catch(async (error: unknown) => {
				if (!(error instanceof CommunityCredentialError)) throw error;
				this.ctx.log.info({ community, reason: error.message }, "migration.provisioningNewAccount");
				return (await this.ctx.provisioner.createBareAccount()).did;
			});
		await this.record(community, { target });
		return target;
	}

	private async finalize(community: string): Promise<void> {
		for (let attempt = 0; attempt < INDEX_ATTEMPTS; attempt += 1) {
			if (await this.ctx.loader.community(community)) break;
			await new Promise((resolve) => setTimeout(resolve, INDEX_POLL_MS));
		}
		await backfillDefaultRole(this.ctx, community);

		const members = await this.ctx.database.db
			.select({ did: this.ctx.database.tables.members.did })
			.from(this.ctx.database.tables.members)
			.where(eq(this.ctx.database.tables.members.community, community));
		for (const member of members) {
			await seedReadCursorsOnJoin(this.ctx, community, member.did);
		}
	}
}

const jobs = new WeakMap<AppContext, MigrationJobs>();

export const migrationJobs = (ctx: AppContext): MigrationJobs => {
	const existing = jobs.get(ctx);
	if (existing) return existing;
	const created = new MigrationJobs(ctx);
	jobs.set(ctx, created);
	return created;
};
