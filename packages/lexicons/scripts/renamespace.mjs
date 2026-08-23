import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const lexiconRoot = join(repoRoot, "packages/lexicons/lexicons");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", "generated"]);
const SOURCE_EXTENSIONS = [".ts", ".mjs", ".md", ".yml", ".yaml"];

const usage = () => {
	console.error("usage: node renamespace.mjs <from-prefix> <to-prefix> [--dry-run]");
	console.error("  e.g. node renamespace.mjs social.colibri social.colibri.beta.beta");
	process.exit(2);
};

const [from, to, ...rest] = process.argv.slice(2);
if (!from || !to || from === to) usage();
if (rest.some((flag) => flag !== "--dry-run")) usage();
const dryRun = rest.includes("--dry-run");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nested = to.startsWith(`${from}.`) ? to.slice(from.length + 1) : null;
const pattern = nested
	? new RegExp(`${escapeRegExp(from)}\\.(?!${escapeRegExp(nested)}\\.)`, "g")
	: new RegExp(`${escapeRegExp(from)}\\.`, "g");

const rewrite = (text) => text.replace(pattern, `${to}.`);

const walk = async (dir) => {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
};

const pathForId = (id) => join(lexiconRoot, `${id.split(".").join("/")}.json`);

const moveLexicons = async () => {
	const ourRoot = join(lexiconRoot, from.split(".")[0]);
	let files;
	try {
		await stat(ourRoot);
		files = (await walk(ourRoot)).filter((file) => file.endsWith(".json"));
	} catch {
		return { moved: 0, unchanged: 0 };
	}

	const writes = [];
	let unchanged = 0;
	for (const file of files) {
		const text = await readFile(file, "utf8");
		const doc = JSON.parse(text);
		if (typeof doc.id !== "string" || !doc.id.startsWith(`${from}.`)) {
			unchanged += 1;
			continue;
		}
		const next = rewrite(text);
		const nextId = JSON.parse(next).id;
		if (nextId === doc.id) {
			unchanged += 1;
			continue;
		}
		writes.push({ from: file, to: pathForId(nextId), text: next });
	}

	if (!dryRun) {
		for (const write of writes) await rm(write.from);
		for (const write of writes) {
			await mkdir(dirname(write.to), { recursive: true });
			await writeFile(write.to, write.text);
		}
		await pruneEmpty(ourRoot);
	}

	for (const write of writes) {
		console.log(`  ${relative(repoRoot, write.from)} -> ${relative(repoRoot, write.to)}`);
	}
	return { moved: writes.length, unchanged };
};

const pruneEmpty = async (dir) => {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) await pruneEmpty(join(dir, entry.name));
	}
	if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true });
};

const rewriteSources = async () => {
	const files = (await walk(repoRoot)).filter(
		(file) =>
			SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
			!file.startsWith(join(repoRoot, "packages/lexicons/lexicons")),
	);

	let touched = 0;
	let replacements = 0;
	for (const file of files) {
		const text = await readFile(file, "utf8");
		const matches = text.match(pattern);
		if (!matches) continue;
		touched += 1;
		replacements += matches.length;
		if (!dryRun) await writeFile(file, rewrite(text));
		console.log(`  ${relative(repoRoot, file)} (${matches.length})`);
	}
	return { touched, replacements };
};

console.log(`${dryRun ? "[dry run] " : ""}renaming ${from}.* to ${to}.*\n`);
console.log("lexicon documents:");
const lexicons = await moveLexicons();
console.log("\nsource files:");
const sources = await rewriteSources();

console.log(
	`\n${lexicons.moved} lexicons moved, ${sources.replacements} references rewritten across ${sources.touched} files`,
);
if (lexicons.unchanged) console.log(`${lexicons.unchanged} lexicons left alone`);
if (dryRun) console.log("\nnothing written, drop --dry-run to apply");
else console.log("\nnow run: pnpm lexicons:codegen");
