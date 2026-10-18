const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: "\u2002",
	emsp: "\u2003",
	thinsp: "\u2009",
	hellip: "\u2026",
	ndash: "\u2013",
	mdash: "\u2014",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

export function decodeEntities(input: string): string {
	return input.replace(ENTITY_PATTERN, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const isHex = entity[1] === "x" || entity[1] === "X";
			const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		return NAMED_ENTITIES[entity] ?? match;
	});
}

const ATTRIBUTE_PATTERN =
	/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttributes(tag: string): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
		const name = match[1]?.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		if (name && !attrs.has(name)) attrs.set(name, decodeEntities(value));
	}
	return attrs;
}

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;

export function extractMetaTags(html: string): Map<string, string> {
	const metas = new Map<string, string>();
	for (const match of html.matchAll(META_TAG_PATTERN)) {
		const attrs = parseAttributes(match[0]);
		const key = attrs.get("property") ?? attrs.get("name");
		const content = attrs.get("content");
		if (!key || content === undefined) continue;

		const trimmed = content.trim();
		const lowerKey = key.toLowerCase();
		if (trimmed.length > 0 && !metas.has(lowerKey)) metas.set(lowerKey, trimmed);
	}
	return metas;
}

export function extractMetaValues(html: string, key: string): string[] {
	const wanted = key.toLowerCase();
	const values: string[] = [];
	for (const match of html.matchAll(META_TAG_PATTERN)) {
		const attrs = parseAttributes(match[0]);
		const name = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
		const content = attrs.get("content")?.trim();
		if (name === wanted && content) values.push(content);
	}
	return values;
}

export type LinkTag = {
	rel: string[];
	href: string;
	type?: string;
	sizes?: string;
};

const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;

export function extractLinkTags(html: string): LinkTag[] {
	const links: LinkTag[] = [];
	for (const match of html.matchAll(LINK_TAG_PATTERN)) {
		const attrs = parseAttributes(match[0]);
		const href = attrs.get("href")?.trim();
		const rel = attrs.get("rel")?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
		if (!href || rel.length === 0) continue;
		const type = attrs.get("type")?.trim().toLowerCase();
		const sizes = attrs.get("sizes")?.trim().toLowerCase();
		links.push({ rel, href, ...(type ? { type } : {}), ...(sizes ? { sizes } : {}) });
	}
	return links;
}

const TITLE_TAG_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

export function extractTitleTag(html: string): string | undefined {
	const match = TITLE_TAG_PATTERN.exec(html);
	if (!match) return undefined;
	const text = decodeEntities(match[1] ?? "").trim();
	return text.length > 0 ? text : undefined;
}

const HEAD_CLOSE_PATTERN = /<\/head\s*>/i;

export function containsHeadClose(buffer: Buffer): boolean {
	return HEAD_CLOSE_PATTERN.test(buffer.toString("latin1"));
}
