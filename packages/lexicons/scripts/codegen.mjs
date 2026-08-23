import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));

const result = spawnSync(
	"lex",
	[
		"build",
		"--lexicons",
		"./lexicons",
		"--out",
		"./src/generated",
		"--clear",
		"--index-file",
		"--defs-export",
		"--pretty",
		"false",
	],
	{ cwd, stdio: "inherit", shell: true },
);

process.exit(result.status ?? 1);
