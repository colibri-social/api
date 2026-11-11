import { describe, expect, it } from "vitest";
import type { StatusDeps } from "./commands.js";
import { fakeKuma } from "./fake-kuma.js";
import { type Prompts, runStatusTui } from "./tui.js";

const CANCEL = Symbol("cancel");

const scripted = (answers: unknown[]): Prompts & { notes: string[] } => {
	const queue = [...answers];
	const notes: string[] = [];
	const next = async () => (queue.length > 0 ? queue.shift() : CANCEL);

	return {
		notes,
		intro: () => {},
		outro: () => {},
		note: (message) => notes.push(message),
		select: next as Prompts["select"],
		multiselect: next as Prompts["multiselect"],
		text: next as Prompts["text"],
		confirm: next as Prompts["confirm"],
		isCancel: (value): value is symbol => value === CANCEL,
	};
};

const deps = (kuma: ReturnType<typeof fakeKuma>): StatusDeps => {
	return {
		kuma: kuma.api,
		slug: "colibri",
		nodes: async () => [],
		print: () => {},
		now: () => new Date("2026-11-11T09:05:00Z"),
	};
};

describe("runStatusTui", () => {
	it("opens an incident, posts an update and resolves it", async () => {
		const kuma = fakeKuma();
		const prompts = scripted([
			"incidents",
			-1,
			"Sign-in fails",
			"danger",
			"Looking into it.",
			1,
			"update",
			"Fix is rolling out.",
			1,
			"resolve",
			"",
			true,
			0,
			"quit",
		]);

		await runStatusTui(deps(kuma), prompts);

		expect(kuma.incidents[0]).toMatchObject({
			title: "Sign-in fails",
			style: "danger",
			active: false,
			content: "**09:05 UTC** · Fix is rolling out.\n\n**09:05 UTC** · Looking into it.",
		});
	});

	it("leaves on Escape from the first menu", async () => {
		const kuma = fakeKuma();

		await runStatusTui(deps(kuma), scripted([]));

		expect(kuma.incidents).toEqual([]);
	});
});
