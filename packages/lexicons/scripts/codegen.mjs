import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

if (result.status !== 0) process.exit(result.status ?? 1);

const SPACE_COLLECTIONS = /(l\.space\([^[]*\[)([^\]]*)(\]\))/g;
const WIDENED = "] as readonly (l.RecordSchema | l.TypedRefSchema<l.RecordSchema>)[])";

const widenSpaceCollections = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) {
			widenSpaceCollections(path);
			continue;
		}

		if (!entry.name.endsWith(".defs.ts")) continue;

		const source = readFileSync(path, "utf8");
		const widened = source.replace(
			SPACE_COLLECTIONS,
			(_, head, body) => `${head}${body}${WIDENED}`,
		);

		if (widened !== source) writeFileSync(path, widened);
	}
};

widenSpaceCollections(join(cwd, "src", "generated"));
