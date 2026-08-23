import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/schema/sqlite.ts", import.meta.url));
const target = fileURLToPath(new URL("../src/schema/pg.ts", import.meta.url));

const HEADER = `/*
 * Generated from sqlite.ts by scripts/generate-pg-schema.mjs. Do not edit.
 */

`;

const HELPER_LINE = /^const (json|flag|timestamp) = /;

const UNSUPPORTED = [
	[/text\([^)]*\{\s*mode:/, "text() with a mode, outside the json helper"],
	[/integer\([^)]*\{\s*mode:/, "integer() with a mode, outside the flag helper"],
	[/\bblob\(/, "blob()"],
	[/\breal\(/, "real()"],
	[/\bsql`/, "raw SQL"],
];

const REWRITES = [
	[/from "drizzle-orm\/sqlite-core"/g, 'from "drizzle-orm/pg-core"'],
	[/\bsqliteTable\b/g, "pgTable"],
	[
		/const json = <T>\(name: string\) => text\(name, \{ mode: "json" \}\)\.\$type<T>\(\)/,
		"const json = <T>(name: string) => jsonb(name).$type<T>()",
	],
	[
		/const flag = \(name: string\) => integer\(name, \{ mode: "boolean" \}\)/,
		"const flag = (name: string) => boolean(name)",
	],
	[
		/^import \{([\s\S]+?)\} from "drizzle-orm\/pg-core";?$/m,
		(_match, names) => {
			const named = names.split(/[\s,]+/).filter(Boolean);
			const imported = new Set([...named, "pgTable", "boolean", "jsonb"]);
			return `import { ${[...imported].sort().join(", ")} } from "drizzle-orm/pg-core";`;
		},
	],
];

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const original = readFileSync(source, "utf8");
const withoutHelpers = original
	.split("\n")
	.filter((line) => !HELPER_LINE.test(line))
	.join("\n");

for (const [pattern, what] of UNSUPPORTED) {
	if (pattern.test(withoutHelpers)) {
		fail(`sqlite.ts uses ${what}. Teach the generator that mapping before using it.`);
	}
}

const generated = REWRITES.reduce(
	(acc, [pattern, replacement]) => acc.replace(pattern, replacement),
	original,
);

if (/sqlite/i.test(generated))
	fail("generated schema still mentions sqlite, so a rewrite did not fire");

writeFileSync(target, HEADER + generated);
console.log(`generated ${target}`);
