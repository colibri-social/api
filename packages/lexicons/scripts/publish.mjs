import { resolveTxt } from "node:dns/promises";
import { authorityFor, loadOurLexicons } from "./lexicon-files.mjs";

const COLLECTION = "com.atproto.lexicon.schema";

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");
const skipDnsCheck = flags.has("--skip-dns-check");
const force = flags.has("--force");

const pds = process.env.LEXICON_PDS;
const identifier = process.env.LEXICON_IDENTIFIER;
const password = process.env.LEXICON_PASSWORD;
const declaredDid = process.env.LEXICON_DID;

if (!pds) {
	console.error("LEXICON_PDS is required, e.g. https://colibri.social");
	process.exit(2);
}

const xrpc = (method) => `${pds.replace(/\/$/, "")}/xrpc/${method}`;

const login = async () => {
	const response = await fetch(xrpc("com.atproto.server.createSession"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
	if (!response.ok) {
		throw new Error(`login failed: ${response.status} ${await response.text()}`);
	}
	return response.json();
};

const didForDryRun = async () => {
	if (declaredDid) return declaredDid;
	if (!identifier) return null;
	const response = await fetch(
		`${xrpc("com.atproto.identity.resolveHandle")}?handle=${encodeURIComponent(identifier)}`,
	);
	if (!response.ok) return null;
	return (await response.json()).did;
};

const authorityDid = async (authority) => {
	try {
		for (const chunks of await resolveTxt(`_lexicon.${authority}`)) {
			const value = chunks.join("");
			if (value.startsWith("did=")) return value.slice(4).trim();
		}
	} catch {
		return null;
	}
	return null;
};

const publishedRecord = async (did, nsid) => {
	const url = `${xrpc("com.atproto.repo.getRecord")}?repo=${encodeURIComponent(did)}&collection=${COLLECTION}&rkey=${encodeURIComponent(nsid)}`;
	const response = await fetch(url);
	if (response.status === 400 || response.status === 404) return null;
	if (!response.ok) throw new Error(`getRecord ${nsid}: ${response.status}`);
	return (await response.json()).value;
};

const CARRIED_OVER = ["revision"];

const schemaBody = (doc, published) => {
	const record = { $type: COLLECTION, ...doc };
	for (const field of CARRIED_OVER) {
		if (published && field in published) record[field] = published[field];
	}
	return record;
};

const comparable = (record) => {
	const { $type, ...rest } = record;
	for (const field of CARRIED_OVER) delete rest[field];
	return JSON.stringify(rest);
};

const sameSchema = (published, next) =>
	published ? comparable(published) === comparable(next) : false;

const putRecord = async (accessJwt, did, nsid, record) => {
	const response = await fetch(xrpc("com.atproto.repo.putRecord"), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${accessJwt}`,
		},
		body: JSON.stringify({ repo: did, collection: COLLECTION, rkey: nsid, record }),
	});
	if (!response.ok) {
		throw new Error(`putRecord ${nsid}: ${response.status} ${await response.text()}`);
	}
};

const docs = await loadOurLexicons();
console.log(`${docs.length} lexicons found under lexicons/\n`);

let did;
let accessJwt = null;
if (dryRun && !password) {
	did = await didForDryRun();
	if (!did) {
		console.error(
			"dry run without a password needs LEXICON_DID, or LEXICON_IDENTIFIER as a resolvable handle",
		);
		process.exit(2);
	}
	console.log(`[dry run] comparing against ${did} (not authenticated)\n`);
} else {
	if (!identifier || !password) {
		console.error("LEXICON_IDENTIFIER and LEXICON_PASSWORD are required to publish");
		process.exit(2);
	}
	const session = await login();
	did = session.did;
	accessJwt = session.accessJwt;
	console.log(`authenticated as ${session.handle} (${did})\n`);
}

const authorityCache = new Map();
const resolvedAuthority = async (authority) => {
	if (!authorityCache.has(authority)) {
		authorityCache.set(authority, await authorityDid(authority));
	}
	return authorityCache.get(authority);
};

const created = [];
const updated = [];
const unchanged = [];
const skipped = [];

for (const { doc } of docs) {
	const nsid = doc.id;
	const authority = authorityFor(nsid);

	if (!skipDnsCheck) {
		const owner = await resolvedAuthority(authority);
		if (owner !== did) {
			skipped.push({
				nsid,
				reason: owner ? `_lexicon.${authority} points at ${owner}` : `no _lexicon.${authority}`,
			});
			continue;
		}
	}

	const existing = await publishedRecord(did, nsid);
	const record = schemaBody(doc, existing);
	if (!force && sameSchema(existing, record)) {
		unchanged.push(nsid);
		continue;
	}

	if (!dryRun) await putRecord(accessJwt, did, nsid, record);
	(existing ? updated : created).push(nsid);
	console.log(`  ${existing ? "update" : "create"}  ${nsid}`);
}

if (skipped.length > 0) {
	console.log(`\n${skipped.length} skipped for DNS:`);
	const byReason = new Map();
	for (const entry of skipped) {
		byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
	}
	for (const [reason, count] of [...byReason].sort()) {
		console.log(`  ${count.toString().padStart(3)}  ${reason}`);
	}
	console.log("\nRun 'pnpm lexicons:check-dns' for the records to add.");
	console.log("'--skip-dns-check' publishes anyway, which can clobber another owner's schema.");
}

console.log(
	`\n${created.length} created, ${updated.length} updated, ${unchanged.length} unchanged, ${skipped.length} skipped`,
);
if (dryRun) console.log("nothing written, drop --dry-run to publish");
process.exit(skipped.length > 0 && !skipDnsCheck ? 1 : 0);
