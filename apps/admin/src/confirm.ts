import { RefusedError } from "./commands.js";

export type Risk = "disruptive" | "irreversible";

export type ConfirmRequest = {
	risk: Risk;
	title: string;
	effects: string[];
	token?: string;
};

export type ConfirmFlags = {
	yes: boolean;
	confirm?: string | undefined;
};

export type ConfirmPrompts = {
	note: (message: string, title?: string) => void;
	confirm: (options: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
	text: (options: { message: string; placeholder?: string }) => Promise<string | symbol>;
	isCancel: (value: unknown) => value is symbol;
};

export const RISK_LABELS: Record<Risk, string> = {
	disruptive: "DISRUPTIVE",
	irreversible: "IRREVERSIBLE",
};

const cancelled = (): never => {
	throw new RefusedError("Cancelled. Nothing changed.");
};

export const createConfirm = (
	prompts: ConfirmPrompts,
	flags: ConfirmFlags,
	interactive: boolean,
) => {
	return async (request: ConfirmRequest): Promise<void> => {
		const token = request.token ?? "";
		const irreversible = request.risk === "irreversible";

		if (irreversible && flags.confirm !== undefined && flags.confirm !== token) {
			throw new RefusedError(`--confirm ${flags.confirm} doesn't match. Pass --confirm ${token}`);
		}

		prompts.note(request.effects.join("\n"), `${RISK_LABELS[request.risk]}: ${request.title}`);

		if (irreversible ? flags.confirm === token : flags.yes) {
			return;
		}

		if (!interactive) {
			throw new RefusedError(
				irreversible
					? `This can't be undone. Run it in a terminal, or pass --confirm ${token}`
					: "Run it in a terminal, or pass --yes",
			);
		}

		if (!irreversible) {
			const answer = await prompts.confirm({ message: "Continue?", initialValue: false });

			if (prompts.isCancel(answer) || answer !== true) cancelled();

			return;
		}

		const answer = await prompts.text({
			message: `This can't be undone. Type ${token} to continue`,
			placeholder: token,
		});

		if (prompts.isCancel(answer) || answer.trim() !== token) cancelled();
	};
};
