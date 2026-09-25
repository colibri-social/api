import { markdownToColibri } from "@colibri-social/bridge-core";
import { describe, expect, it } from "vitest";
import {
	colibriToDiscordMarkdown,
	discordToColibriMarkdown,
	forwardBlock,
	MAX_DISCORD_CONTENT,
	mentionedUsers,
	webhookUsername,
} from "./markdown.js";

const lookups = {
	user: (id: string) => (id === "1" ? "Alice" : undefined),
	role: (id: string) => (id === "2" ? "Moderators" : undefined),
	channel: (id: string) => (id === "3" ? "general" : undefined),
};

describe("discordToColibriMarkdown", () => {
	it("turns user and channel mentions into references, and role mentions into names", () => {
		expect(discordToColibriMarkdown("hi <@1> and <@!1>, ask <@&2> in <#3>", lookups)).toBe(
			"hi [@Alice](bridge:user/1) and [@Alice](bridge:user/1), ask @Moderators in [#general](bridge:room/3)",
		);
	});

	it("falls back when a mention cannot be resolved", () => {
		expect(discordToColibriMarkdown("<@9> <@&9> <#9>", lookups)).toBe(
			"[@unknown-user](bridge:user/9) @unknown-role [#unknown-channel](bridge:room/9)",
		);
	});

	it("keeps custom emoji as shortcodes and spells out timestamps", () => {
		expect(discordToColibriMarkdown("<:wave:123> <a:party:456>", lookups)).toBe(":wave: :party:");
		expect(discordToColibriMarkdown("<t:0:R>", lookups)).toBe("1 Jan 1970, 00:00 UTC");
	});

	it("keeps formatting both dialects share", () => {
		const { text, facets } = markdownToColibri(
			discordToColibriMarkdown("**bold** __under__ ~~gone~~ ||secret||", lookups),
		);

		expect(text).toBe("bold under gone secret");
		expect(facets.map((facet) => facet.features[0]?.$type.split("#")[1])).toEqual([
			"bold",
			"underline",
			"strikethrough",
			"spoiler",
		]);
	});
});

describe("colibriToDiscordMarkdown", () => {
	it("cuts content to the platform limit", () => {
		const long = "a".repeat(MAX_DISCORD_CONTENT + 10);

		expect(colibriToDiscordMarkdown(long)).toHaveLength(MAX_DISCORD_CONTENT);
		expect(colibriToDiscordMarkdown(long).endsWith("...")).toBe(true);
	});
});

describe("webhookUsername", () => {
	it("breaks up names the platform refuses", () => {
		expect(webhookUsername("discord fan")).not.toMatch(/discord/i);
		expect(webhookUsername("Clyde")).not.toMatch(/clyde/i);
	});

	it("adds the Colibri handle after the display name", () => {
		expect(webhookUsername("Lou", "lou.gg")).toBe("Lou (\uff20lou.gg)");
	});

	it("shortens the display name so the handle still fits", () => {
		const username = webhookUsername("x".repeat(100), "someone.colibri.social");

		expect(username).toHaveLength(80);
		expect(username.endsWith(" (\uff20someone.colibri.social)")).toBe(true);
	});

	it("swaps characters the platform refuses in names for lookalikes", () => {
		expect(webhookUsername("a@b #c d:e ```f```")).toBe("a\uff20b \uff03c d\uff1ae f");
	});

	it("never sends an empty or oversized name", () => {
		expect(webhookUsername("   ")).toBe("Colibri user");
		expect(webhookUsername("x".repeat(100))).toHaveLength(80);
	});
});

describe("references", () => {
	it("turns references back into mentions and lists who may be pinged", () => {
		const markdown =
			"[@Alice](bridge:user/1) see [#general](bridge:room/3) and [@Alice](bridge:user/1)";

		expect(colibriToDiscordMarkdown(markdown)).toBe("<@1> see <#3> and <@1>");
		expect(mentionedUsers(markdown)).toEqual(["1"]);
	});
});

describe("forwardBlock", () => {
	it("quotes forwarded text under a heading that links to the source", () => {
		expect(forwardBlock("one\ntwo", "https://example.test/1")).toBe(
			"-# Forwarded from https://example.test/1\n> one\n> two",
		);
		expect(forwardBlock("")).toBe("-# Forwarded");
	});
});
