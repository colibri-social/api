import { openTestDatabase, type TestDatabase } from "@colibri-social/appview-db";
import { channelSpace, type social } from "@colibri-social/lexicons";
import { hydrateNotifications } from "@colibri-social/notifications";
import { spaceRecordUri } from "@colibri-social/space";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { notificationDeps } from "../notification-deps.js";
import { handleDeliverNotification, handleDeliverRead, handleRetract } from "./federation.js";

type NotificationView = social.colibri.beta.notification.defs.NotificationView;

const HOME = "did:web:home.example";
const HOME_ALIAS = "did:web:alias.home.example";
const MARKET = "did:web:market.example";
const USER = "did:plc:userxxxxxxxxxxxxxxxxxxxxxx";
const AUTHOR = "did:plc:authorxxxxxxxxxxxxxxxxxxxx";
const SPACE = "did:plc:spacexxxxxxxxxxxxxxxxxxxxx";

const CHANNEL = channelSpace(SPACE, "social.colibri.beta.channel.text", "general");

let database: TestDatabase;
let ctx: AppContext;
let declared: string[];
let managingApp: string;
let hostLookup: () => Promise<unknown>;
let toUser: ReturnType<typeof vi.fn>;

const notification = (rkey = "3mabcdefghijk"): NotificationView => {
	return {
		id: "remote-id",
		kind: "mention",
		author: { did: AUTHOR, handle: "author.test", displayName: "Author" },
		channel: CHANNEL,
		community: SPACE,
		message: {
			uri: `at://${AUTHOR}/social.colibri.beta.channel.message/${rkey}`,
			rkey,
			channel: CHANNEL,
			author: { did: AUTHOR, handle: "author.test" },
			text: "hi @user",
			createdAt: "2026-11-27T12:00:00.000Z",
			attachments: [],
			reactions: [],
			labels: [],
		},
		indexedAt: "2026-11-27T12:00:00.000Z",
	} as unknown as NotificationView;
};

const stored = () => {
	return database.db.select().from(database.tables.notifications);
};

beforeEach(async () => {
	database = await openTestDatabase();
	declared = [HOME];
	managingApp = MARKET;
	toUser = vi.fn();

	hostLookup = async () => ({
		local: false,
		managingApp,
		endpoint: "https://market.example",
	});

	await database.db.insert(database.tables.remoteSpaces).values({
		did: USER,
		community: SPACE,
		managingApp: MARKET,
		joinedAt: "2026-11-27T11:00:00.000Z",
	});

	ctx = {
		config: {
			APPVIEW_DID: HOME,
			appviewDids: [HOME, HOME_ALIAS],
			FEDERATION_ENABLED: true,
			PUBLIC_URL: "https://home.example",
			pushProviders: [],
			notifications: {},
		},
		database,
		declaredAppviews: {
			allows: async (_did: string, appview: string) => declared.includes(appview),
		},
		spaceHosts: {
			resolve: () => hostLookup(),
		},
		announce: { toUser },
		log: { warn: vi.fn() },
	} as unknown as AppContext;
});

afterEach(async () => {
	await database.destroy();
});

describe("deliverNotification", () => {
	it("stores a delivered notification with its view and tells the user's sockets", async () => {
		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
			spaceName: "Night Market",
			channelName: "general",
		});

		const [row] = await stored();

		expect(row).toMatchObject({
			recipient: USER,
			kind: "mention",
			community: SPACE,
			space: CHANNEL,
			author: AUTHOR,
			messageAuthor: AUTHOR,
			messageRkey: "3mabcdefghijk",
			originAppview: MARKET,
		});

		expect(toUser).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({
				notification: expect.objectContaining({ id: row?.id, kind: "mention" }),
			}),
		);
	});

	it("keeps one notification per message when a delivery repeats", async () => {
		const input = { recipient: USER, notification: notification() };

		await handleDeliverNotification(ctx, MARKET, input);
		await handleDeliverNotification(ctx, MARKET, input);

		expect(await stored()).toHaveLength(1);
	});

	it("refuses a user who hasn't declared this AppView", async () => {
		declared = [MARKET];

		await expect(
			handleDeliverNotification(ctx, MARKET, {
				recipient: USER,
				notification: notification(),
			}),
		).rejects.toMatchObject({ customErrorName: "NotDeclared" });
		expect(await stored()).toEqual([]);
	});

	it("refuses an AppView that doesn't manage the Space", async () => {
		managingApp = "did:web:elsewhere.example";

		await expect(
			handleDeliverNotification(ctx, MARKET, {
				recipient: USER,
				notification: notification(),
			}),
		).rejects.toMatchObject({ customErrorName: "NotManagingApp" });
	});

	it("accepts a user who declared an alias of this AppView", async () => {
		declared = [HOME_ALIAS];

		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
		});

		expect(await stored()).toHaveLength(1);
	});

	it("refuses a user who never joined the Space here", async () => {
		await database.db.delete(database.tables.remoteSpaces);

		await expect(
			handleDeliverNotification(ctx, MARKET, {
				recipient: USER,
				notification: notification(),
			}),
		).rejects.toMatchObject({ type: 403, customErrorName: "NotJoined" });
		expect(await stored()).toEqual([]);
	});

	it("refuses a channel or thread outside the notification's Space", async () => {
		const foreign = channelSpace(AUTHOR, "social.colibri.beta.channel.text", "general");

		for (const override of [{ channel: foreign }, { thread: foreign }]) {
			await expect(
				handleDeliverNotification(ctx, MARKET, {
					recipient: USER,
					notification: { ...notification(), ...override } as NotificationView,
				}),
			).rejects.toMatchObject({ customErrorName: "InvalidRequest" });
		}

		expect(await stored()).toEqual([]);
	});

	it("answers UpstreamFailure when the Space's host can't be looked up", async () => {
		hostLookup = async () => {
			throw new Error("plc down");
		};

		await expect(
			handleDeliverNotification(ctx, MARKET, {
				recipient: USER,
				notification: notification(),
			}),
		).rejects.toMatchObject({ type: 502, customErrorName: "UpstreamFailure" });
	});

	it.each([
		["blocks", AUTHOR],
		["mutes", AUTHOR],
		["mutes", SPACE],
		["mutes", CHANNEL],
	] as const)("drops a delivery quietly when the user %s %s", async (table, subject) => {
		await database.db.insert(database.tables[table]).values({
			did: USER,
			rkey: "3mblockormute",
			subject,
			createdAt: "2026-11-27T11:00:00.000Z",
		});

		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
		});

		expect(await stored()).toEqual([]);
		expect(toUser).not.toHaveBeenCalled();
	});

	it("announces a repeated delivery only once", async () => {
		const input = { recipient: USER, notification: notification() };

		await handleDeliverNotification(ctx, MARKET, input);
		await handleDeliverNotification(ctx, MARKET, input);

		expect(toUser).toHaveBeenCalledOnce();
	});

	it("lists a delivered notification from its stored view", async () => {
		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
		});

		const rows = await stored();

		const views = await hydrateNotifications(notificationDeps(ctx), rows, {
			hydrate: async () => new Map(),
		} as never);

		expect(views).toEqual([
			expect.objectContaining({
				id: rows[0]?.id,
				kind: "mention",
				channel: CHANNEL,
				message: expect.objectContaining({ text: "hi @user" }),
			}),
		]);
	});
});

describe("retract", () => {
	const message = (rkey = "3mabcdefghijk") => {
		return spaceRecordUri(CHANNEL, AUTHOR, "social.colibri.beta.channel.message", rkey);
	};

	it("drops the notification the managing AppView delivered and updates the badge", async () => {
		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
		});

		await handleRetract(ctx, MARKET, {
			recipient: USER,
			message: message(),
		});

		expect(await stored()).toEqual([]);

		expect(toUser).toHaveBeenLastCalledWith(USER, expect.objectContaining({ unread: 0 }));
	});

	it("leaves notifications from other AppViews alone", async () => {
		await handleDeliverNotification(ctx, MARKET, {
			recipient: USER,
			notification: notification(),
		});

		managingApp = "did:web:elsewhere.example";

		await expect(
			handleRetract(ctx, MARKET, { recipient: USER, message: message() }),
		).rejects.toMatchObject({ customErrorName: "NotManagingApp" });

		expect(await stored()).toHaveLength(1);
	});

	it("refuses something that isn't a message", async () => {
		await expect(
			handleRetract(ctx, MARKET, { recipient: USER, message: "nonsense" }),
		).rejects.toMatchObject({ customErrorName: "InvalidRequest" });
	});
});

describe("deliverRead", () => {
	it("accepts a read from the managing AppView", async () => {
		await expect(
			handleDeliverRead(ctx, MARKET, {
				recipient: USER,
				channel: CHANNEL,
				through: "3mabcdefghijk",
			}),
		).resolves.toBeUndefined();
	});

	it("refuses a read from an AppView that doesn't manage the Space", async () => {
		managingApp = "did:web:elsewhere.example";

		await expect(
			handleDeliverRead(ctx, MARKET, {
				recipient: USER,
				channel: CHANNEL,
				through: "3mabcdefghijk",
			}),
		).rejects.toMatchObject({ customErrorName: "NotManagingApp" });
	});
});
