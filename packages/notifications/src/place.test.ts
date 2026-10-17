import { describe, expect, it } from "vitest";
import { kindLabel, notificationSubtitle, placeLocation, placeName } from "./place.js";

const CHANNEL = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchannel1";
const THREAD = "at://did:plc:community/space/social.colibri.beta.channel.thread/3lkthread1";

const mention = { kind: "mention", mentionRole: null };

describe("kindLabel", () => {
	it("matches the in-app labels", () => {
		expect(kindLabel({ kind: "reply", mentionRole: null })).toBe("Replied to you");
		expect(kindLabel(mention)).toBe("Mentioned you");
		expect(kindLabel({ kind: "mention", mentionRole: "mods" })).toBe("Mentioned @mods");
		expect(kindLabel({ kind: "message", mentionRole: null })).toBeUndefined();
	});
});

describe("notificationSubtitle", () => {
	const place = { channel: CHANNEL, spaceName: "Protocol Nerds", channelName: "general" };

	it("joins the kind label, the Space and the channel", () => {
		expect(notificationSubtitle(mention, place)).toBe("Mentioned you · Protocol Nerds › #general");
	});

	it("leaves the kind label out for plain messages", () => {
		expect(notificationSubtitle({ kind: "message", mentionRole: null }, place)).toBe(
			"Protocol Nerds › #general",
		);
	});

	it("names the thread instead of the channel", () => {
		expect(
			notificationSubtitle(
				{ kind: "reply", mentionRole: null },
				{ ...place, thread: THREAD, threadName: "Launch plans" },
			),
		).toBe("Replied to you · Protocol Nerds › Launch plans");
	});

	it("falls back to the parent channel for an unnamed thread", () => {
		expect(placeLocation({ ...place, thread: THREAD })).toBe("Thread in #general");
		expect(placeName({ ...place, thread: THREAD })).toBe("general");
	});

	it("drops the Space when its name is unknown and uses the channel key", () => {
		expect(notificationSubtitle(mention, { channel: CHANNEL })).toBe(
			"Mentioned you · #3lkchannel1",
		);
		expect(placeName({ channel: CHANNEL })).toBe("3lkchannel1");
	});
});
