import { describe, expect, it, vi } from "vitest";
import { RefusedError } from "./commands.js";
import { type ConfirmPrompts, createConfirm } from "./confirm.js";

const CANCEL = Symbol("cancel");

const prompts = (answers: { confirm?: boolean | symbol; text?: string | symbol } = {}) => {
	return {
		note: vi.fn(),
		confirm: vi.fn(async () => answers.confirm ?? false),
		text: vi.fn(async () => answers.text ?? ""),
		isCancel: (value: unknown): value is symbol => value === CANCEL,
	} satisfies ConfirmPrompts;
};

const disruptive = {
	risk: "disruptive" as const,
	title: "restart eu-2",
	effects: ["Restarts it."],
};

const irreversible = {
	risk: "irreversible" as const,
	title: "remove eu-2",
	token: "eu-2",
	effects: ["Deletes it."],
};

describe("createConfirm", () => {
	it("labels the effects by risk", async () => {
		const io = prompts({ confirm: true });

		await createConfirm(io, { yes: false }, true)(disruptive);

		expect(io.note).toHaveBeenCalledWith("Restarts it.", "DISRUPTIVE: restart eu-2");
	});

	it("asks yes or no for a disruptive command and refuses on no or cancel", async () => {
		await expect(
			createConfirm(prompts({ confirm: true }), { yes: false }, true)(disruptive),
		).resolves.toBeUndefined();
		await expect(
			createConfirm(prompts({ confirm: false }), { yes: false }, true)(disruptive),
		).rejects.toThrow("Cancelled. Nothing changed.");
		await expect(
			createConfirm(prompts({ confirm: CANCEL }), { yes: false }, true)(disruptive),
		).rejects.toThrow(RefusedError);
	});

	it("skips the question with --yes for disruptive commands only", async () => {
		const io = prompts();

		await createConfirm(io, { yes: true }, false)(disruptive);

		expect(io.confirm).not.toHaveBeenCalled();
		await expect(createConfirm(io, { yes: true }, false)(irreversible)).rejects.toThrow(
			/--confirm eu-2/,
		);
	});

	it("asks for the token on an irreversible command", async () => {
		await expect(
			createConfirm(prompts({ text: "eu-2" }), { yes: false }, true)(irreversible),
		).resolves.toBeUndefined();
		await expect(
			createConfirm(prompts({ text: "eu-3" }), { yes: true }, true)(irreversible),
		).rejects.toThrow(/Cancelled/);
	});

	it("takes a matching --confirm and refuses a wrong one", async () => {
		const io = prompts();

		await createConfirm(io, { yes: false, confirm: "eu-2" }, false)(irreversible);

		expect(io.text).not.toHaveBeenCalled();
		await expect(
			createConfirm(io, { yes: false, confirm: "eu-3" }, true)(irreversible),
		).rejects.toThrow(/doesn't match/);
	});

	it("refuses without a terminal and without a flag", async () => {
		await expect(createConfirm(prompts(), { yes: false }, false)(disruptive)).rejects.toThrow(
			/pass --yes/,
		);
	});
});
