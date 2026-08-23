import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lexiconDir = fileURLToPath(new URL("../lexicons", import.meta.url));

type Doc = { lexicon: number; id: string; defs: Record<string, Def> };
type Def = Record<string, unknown> & { type: string };

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(join(dir, entry.name))
			: entry.name.endsWith(".json")
				? [join(dir, entry.name)]
				: [],
	);

const files = walk(lexiconDir).sort();
const docs = files.map((path) => ({
	path,
	relative: relative(lexiconDir, path),
	doc: JSON.parse(readFileSync(path, "utf8")) as Doc,
}));

const isOurs = (id: string) => id.startsWith("social.colibri.");
const ours = docs.filter(({ doc }) => isOurs(doc.id));

const byId = new Map(docs.map(({ doc }) => [doc.id, doc]));

const METHOD_TYPES = new Set(["query", "procedure", "subscription"]);

const METHODS_WITHOUT_ERRORS = new Set(["social.colibri.server.describeServer"]);

const walkNodes = function* (
	node: unknown,
	path: string,
): Generator<[string, Record<string, unknown>]> {
	if (Array.isArray(node)) {
		for (const [i, entry] of node.entries()) yield* walkNodes(entry, `${path}[${i}]`);
		return;
	}
	if (node === null || typeof node !== "object") return;
	yield [path, node as Record<string, unknown>];
	for (const [key, value] of Object.entries(node)) yield* walkNodes(value, `${path}.${key}`);
};

const refsIn = (doc: Doc): Array<{ ref: string; at: string }> => {
	const out: Array<{ ref: string; at: string }> = [];
	for (const [at, node] of walkNodes(doc.defs, "$.defs")) {
		if (typeof node.ref === "string") out.push({ ref: node.ref, at });
		if (Array.isArray(node.refs))
			for (const ref of node.refs) if (typeof ref === "string") out.push({ ref, at });
	}
	return out;
};

const resolveRef = (ref: string, fromId: string): boolean => {
	const [nsid, name = "main"] = ref.startsWith("#") ? [fromId, ref.slice(1)] : ref.split("#");
	const target = byId.get(nsid as string);
	return target !== undefined && name in target.defs;
};

describe("lexicon documents", () => {
	it("every document's id matches its path", () => {
		const mismatched = docs
			.filter(
				({ doc, relative: rel }) =>
					doc.id !==
					rel
						.replace(/\.json$/, "")
						.split(sep)
						.join("."),
			)
			.map(({ relative: rel, doc }) => `${rel} declares ${doc.id}`);
		expect(mismatched).toEqual([]);
	});

	it("every reference resolves", () => {
		const broken = docs.flatMap(({ doc }) =>
			refsIn(doc)
				.filter(({ ref }) => !resolveRef(ref, doc.id))
				.map(({ ref, at }) => `${doc.id} ${at} -> ${ref}`),
		);
		expect(broken).toEqual([]);
	});

	it("no reference uses the legacy lex: prefix", () => {
		const legacy = docs.flatMap(({ doc }) =>
			refsIn(doc)
				.filter(({ ref }) => ref.startsWith("lex:"))
				.map(({ ref, at }) => `${doc.id} ${at} -> ${ref}`),
		);
		expect(legacy).toEqual([]);
	});

	it("same-document references use the short form", () => {
		const verbose = ours.flatMap(({ doc }) =>
			refsIn(doc)
				.filter(({ ref }) => ref.startsWith(`${doc.id}#`))
				.map(({ ref, at }) => `${doc.id} ${at} -> ${ref}`),
		);
		expect(verbose).toEqual([]);
	});
});

describe("colibri methods", () => {
	const methods = ours.filter(({ doc }) => METHOD_TYPES.has(doc.defs.main?.type ?? ""));

	it("declares errors", () => {
		const missing = methods
			.filter(({ doc }) => !METHODS_WITHOUT_ERRORS.has(doc.id))
			.filter(({ doc }) => !Array.isArray((doc.defs.main as Record<string, unknown>).errors))
			.map(({ doc }) => doc.id);
		expect(missing).toEqual([]);
	});

	it("names errors in PascalCase", () => {
		const bad = methods.flatMap(({ doc }) => {
			const errors = (doc.defs.main as { errors?: Array<{ name: string }> }).errors ?? [];
			return errors
				.filter((error) => !/^[A-Z][A-Za-z0-9]*$/.test(error.name))
				.map((error) => `${doc.id}: ${error.name}`);
		});
		expect(bad).toEqual([]);
	});

	it("describes every error", () => {
		const bare = methods.flatMap(({ doc }) => {
			const errors =
				(doc.defs.main as { errors?: Array<{ name: string; description?: string }> }).errors ?? [];
			return errors
				.filter((error) => !error.description)
				.map((error) => `${doc.id}: ${error.name}`);
		});
		expect(bare).toEqual([]);
	});

	it("uses the standard shape for limit and cursor", () => {
		const problems: string[] = [];
		for (const { doc } of methods) {
			const main = doc.defs.main as {
				parameters?: { properties?: Record<string, Record<string, unknown>> };
			};
			const limit = main.parameters?.properties?.limit;
			if (!limit) continue;
			if (limit.type !== "integer" || limit.minimum !== 1 || typeof limit.default !== "number")
				problems.push(`${doc.id}: limit must be an integer with minimum 1 and a default`);
		}
		expect(problems).toEqual([]);
	});

	it("never marks an output cursor required", () => {
		const problems = methods
			.filter(({ doc }) => {
				const schema = (doc.defs.main as { output?: { schema?: { required?: string[] } } }).output
					?.schema;
				return schema?.required?.includes("cursor") ?? false;
			})
			.map(({ doc }) => doc.id);
		expect(problems).toEqual([]);
	});
});

describe("colibri descriptions", () => {
	const isDescribed = (def: Def) => {
		const text = def.type === "permission-set" ? def.detail : def.description;
		return typeof text === "string" && text.length > 0;
	};

	it("describes every named definition", () => {
		const bare = ours.flatMap(({ doc }) =>
			Object.entries(doc.defs)
				.filter(([, def]) => !isDescribed(def))
				.map(([name]) => `${doc.id}#${name}`),
		);
		expect(bare).toEqual([]);
	});

	it("titles every permission set", () => {
		const untitled = ours
			.filter(({ doc }) => doc.defs.main?.type === "permission-set")
			.filter(({ doc }) => typeof (doc.defs.main as { title?: string }).title !== "string")
			.map(({ doc }) => doc.id);
		expect(untitled).toEqual([]);
	});

	it("describes every property", () => {
		const bare = ours.flatMap(({ doc }) => {
			const out: string[] = [];
			for (const [at, node] of walkNodes(doc.defs, "$.defs")) {
				if (!node.properties || typeof node.properties !== "object") continue;
				for (const [name, prop] of Object.entries(node.properties as Record<string, unknown>)) {
					const described =
						prop !== null &&
						typeof prop === "object" &&
						typeof (prop as { description?: unknown }).description === "string";
					if (!described) out.push(`${doc.id} ${at}.${name}`);
				}
			}
			return out;
		});
		expect(bare).toEqual([]);
	});

	it("uses no em dashes and no prose semicolons", () => {
		const offenders = ours.flatMap(({ doc }) => {
			const out: string[] = [];
			for (const [at, node] of walkNodes(doc.defs, "$.defs")) {
				const text = node.description;
				if (typeof text !== "string") continue;
				if (text.includes("—")) out.push(`${doc.id} ${at}: em dash`);
				if (text.includes(";")) out.push(`${doc.id} ${at}: semicolon`);
			}
			return out;
		});
		expect(offenders).toEqual([]);
	});
});

describe("space types", () => {
	const spaces = ours.filter(({ doc }) => doc.defs.main?.type === "space");

	it("exist", () => {
		expect(spaces.length).toBeGreaterThan(0);
	});

	it("only list collections that are defined records", () => {
		const recordIds = new Set(
			docs.filter(({ doc }) => doc.defs.main?.type === "record").map(({ doc }) => doc.id),
		);
		const dangling = spaces.flatMap(({ doc }) => {
			const collections = (doc.defs.main as { collections?: string[] }).collections ?? [];
			return collections.filter((c) => !recordIds.has(c)).map((c) => `${doc.id} -> ${c}`);
		});
		expect(dangling).toEqual([]);
	});

	it("names every space type for a consent screen", () => {
		const unnamed = spaces
			.filter(({ doc }) => {
				const name = (doc.defs.main as { name?: string }).name;
				return typeof name !== "string" || name.length === 0 || name.length > 64;
			})
			.map(({ doc }) => doc.id);
		expect(unnamed).toEqual([]);
	});
});

describe("permission sets", () => {
	const sets = ours.filter(({ doc }) => doc.defs.main?.type === "permission-set");
	const methodIds = new Set(
		ours.filter(({ doc }) => METHOD_TYPES.has(doc.defs.main?.type ?? "")).map(({ doc }) => doc.id),
	);
	const spaceTypeIds = new Set(
		ours.filter(({ doc }) => doc.defs.main?.type === "space").map(({ doc }) => doc.id),
	);

	type Permission = {
		resource: string;
		lxm?: string[];
		spaceType?: string;
		collection?: string[];
	};
	const permissionsOf = (doc: Doc) =>
		((doc.defs.main as { permissions?: Permission[] }).permissions ?? []) as Permission[];

	it("exist", () => {
		expect(sets.length).toBeGreaterThan(0);
	});

	it("only grant methods that exist", () => {
		const dangling = sets.flatMap(({ doc }) =>
			permissionsOf(doc)
				.filter((p) => p.resource === "rpc")
				.flatMap((p) => p.lxm ?? [])
				.filter((lxm) => !methodIds.has(lxm))
				.map((lxm) => `${doc.id} -> ${lxm}`),
		);
		expect(dangling).toEqual([]);
	});

	it("only name space types that exist", () => {
		const dangling = sets.flatMap(({ doc }) =>
			permissionsOf(doc)
				.filter((p) => p.resource === "space" && p.spaceType)
				.filter((p) => !spaceTypeIds.has(p.spaceType as string))
				.map((p) => `${doc.id} -> ${p.spaceType}`),
		);
		expect(dangling).toEqual([]);
	});

	it("covers every method with at least one permission set", () => {
		const granted = new Set(
			sets.flatMap(({ doc }) =>
				permissionsOf(doc)
					.filter((p) => p.resource === "rpc")
					.flatMap((p) => p.lxm ?? []),
			),
		);
		const ungoverned = [...methodIds].filter((id) => !granted.has(id)).sort();
		expect(ungoverned).toEqual([]);
	});
});
