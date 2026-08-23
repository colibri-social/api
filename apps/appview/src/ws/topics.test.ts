import { describe, expect, it } from "vitest";
import { channelTopic, communityTopic, TopicIndex, userTopic } from "./topics.js";

const COMMUNITY = "did:plc:community";
const CHANNEL = "at://did:plc:community/space/social.colibri.beta.channel.text/3lkchan";

describe("topic fan-out", () => {
	it("delivers only to subscribers of a topic", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [communityTopic(COMMUNITY)]);
		index.subscribe("bob", [communityTopic("did:plc:elsewhere")]);

		expect([...index.subscribersOf(communityTopic(COMMUNITY))]).toEqual(["alice"]);
	});

	it("keeps several subscribers on one topic", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [channelTopic(CHANNEL)]);
		index.subscribe("bob", [channelTopic(CHANNEL)]);
		expect([...index.subscribersOf(channelTopic(CHANNEL))].sort()).toEqual(["alice", "bob"]);
	});

	it("is idempotent", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [channelTopic(CHANNEL)]);
		index.subscribe("alice", [channelTopic(CHANNEL)]);
		expect([...index.subscribersOf(channelTopic(CHANNEL))]).toEqual(["alice"]);
		expect(index.topicsOf("alice")).toEqual([channelTopic(CHANNEL)]);
	});

	it("stops delivering after an unsubscribe", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [channelTopic(CHANNEL), userTopic("did:plc:alice")]);
		index.unsubscribe("alice", [channelTopic(CHANNEL)]);

		expect([...index.subscribersOf(channelTopic(CHANNEL))]).toEqual([]);
		expect(index.topicsOf("alice")).toEqual([userTopic("did:plc:alice")]);
	});

	it("drops every topic when a connection goes away", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [communityTopic(COMMUNITY), channelTopic(CHANNEL)]);
		index.forget("alice");

		expect(index.size).toBe(0);
		expect([...index.subscribersOf(communityTopic(COMMUNITY))]).toEqual([]);
		expect([...index.subscribersOf(channelTopic(CHANNEL))]).toEqual([]);
	});

	it("forgets an empty topic rather than keeping the entry", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [channelTopic(CHANNEL)]);
		index.forget("alice");
		expect([...index.subscribersOf(channelTopic(CHANNEL))]).toEqual([]);
	});

	it("ignores an unsubscribe from a connection that never subscribed", () => {
		const index = new TopicIndex<string>();
		expect(() => index.unsubscribe("nobody", [channelTopic(CHANNEL)])).not.toThrow();
	});

	it("keeps community and channel topics distinct", () => {
		const index = new TopicIndex<string>();
		index.subscribe("alice", [communityTopic(COMMUNITY)]);
		expect([...index.subscribersOf(channelTopic(CHANNEL))]).toEqual([]);
	});
});
