import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEXICON_ROOT = fileURLToPath(new URL("../lexicons", import.meta.url));

export const OUR_PREFIX = "social.colibri.beta";

const walk = async (dir) => {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (entry.name.endsWith(".json")) out.push(full);
	}
	return out;
};

export const loadOurLexicons = async () => {
	const files = await walk(LEXICON_ROOT);
	const docs = [];
	for (const file of files) {
		const doc = JSON.parse(await readFile(file, "utf8"));
		if (typeof doc.id !== "string") continue;
		if (!doc.id.startsWith(`${OUR_PREFIX}.`) && doc.id !== OUR_PREFIX) continue;
		docs.push({ file, doc });
	}
	return docs.sort((a, b) => a.doc.id.localeCompare(b.doc.id));
};

export const authorityFor = (nsid) => {
	const segments = nsid.split(".");
	return segments.slice(0, -1).reverse().join(".");
};

export const authoritiesFor = (docs) => {
	const byAuthority = new Map();
	for (const { doc } of docs) {
		const authority = authorityFor(doc.id);
		const list = byAuthority.get(authority) ?? [];
		list.push(doc.id);
		byAuthority.set(authority, list);
	}
	return new Map([...byAuthority.entries()].sort(([a], [b]) => a.localeCompare(b)));
};
