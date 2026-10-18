import { decodeEntities } from "./html.js";
import type { RichBlock, RichSpan } from "./types.js";

export const MAX_RICH_TEXT_LENGTH = 4096;

const TOKEN_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<!--[\s\S]*?-->|([^<]+)|</g;
const CLASS_PATTERN = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const SKIPPED_TAGS = new Set(["script", "style", "template"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"]);
const BOLD_TAGS = new Set(["b", "strong"]);
const ITALIC_TAGS = new Set(["i", "em"]);

const attribute = (pattern: RegExp, attrs: string): string | undefined => {
	const match = pattern.exec(attrs);
	if (!match) return undefined;
	return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
};

const safeHref = (raw: string | undefined): string | undefined => {
	if (!raw) return undefined;
	try {
		const url = new URL(raw.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
};

type Format = Omit<RichSpan, "text">;

const sameFormat = (a: Format, b: Format): boolean =>
	a.bold === b.bold && a.italic === b.italic && a.href === b.href;

const trimBlock = (spans: RichSpan[]): RichSpan[] => {
	const out = spans.map((span) => ({ ...span }));
	while (out.length > 0) {
		const first = out[0] as RichSpan;
		first.text = first.text.replace(/^\s+/, "");
		if (first.text.length > 0) break;
		out.shift();
	}
	while (out.length > 0) {
		const last = out[out.length - 1] as RichSpan;
		last.text = last.text.replace(/\s+$/, "");
		if (last.text.length > 0) break;
		out.pop();
	}
	return out;
};

export function htmlToRichBlocks(html: string, maxLength = MAX_RICH_TEXT_LENGTH): RichBlock[] {
	const blocks: RichBlock[] = [];
	let spans: RichSpan[] = [];
	let quoteDepth = 0;
	let boldDepth = 0;
	let italicDepth = 0;
	let skipDepth = 0;
	let hiddenDepth = 0;
	const spanHidden: boolean[] = [];
	const hrefs: (string | undefined)[] = [];
	let length = 0;
	let full = false;

	const flush = () => {
		const trimmed = trimBlock(spans);
		spans = [];
		if (trimmed.length > 0)
			blocks.push({ kind: quoteDepth > 0 ? "quote" : "paragraph", spans: trimmed });
	};

	const append = (raw: string) => {
		if (full || raw.length === 0) return;
		let text = raw;
		if (length + text.length > maxLength) {
			text = `${text.slice(0, Math.max(0, maxLength - length))}...`;
			full = true;
		}
		length += text.length;
		const href = hrefs.findLast((entry) => entry !== undefined);
		const format: Format = {
			...(boldDepth > 0 ? { bold: true } : {}),
			...(italicDepth > 0 ? { italic: true } : {}),
			...(href ? { href } : {}),
		};
		const previous = spans[spans.length - 1];
		if (previous && sameFormat(previous, format)) {
			previous.text += text;
			return;
		}
		spans.push({ text, ...format });
	};

	for (const match of html.matchAll(TOKEN_PATTERN)) {
		const [, closing, rawName, attrs = "", text] = match;
		if (text !== undefined || match[0] === "<") {
			if (skipDepth > 0 || hiddenDepth > 0) continue;
			append(decodeEntities((text ?? "<").replace(/\s+/g, " ")));
			continue;
		}
		if (!rawName) continue;
		const name = rawName.toLowerCase();
		const opening = closing !== "/";

		if (SKIPPED_TAGS.has(name)) {
			skipDepth = Math.max(0, skipDepth + (opening ? 1 : -1));
			continue;
		}
		if (skipDepth > 0) continue;

		if (name === "span") {
			if (opening && !attrs.trimEnd().endsWith("/")) {
				const hidden = /\binvisible\b/.test(attribute(CLASS_PATTERN, attrs) ?? "");
				spanHidden.push(hidden);
				if (hidden) hiddenDepth += 1;
			} else if (!opening && spanHidden.pop()) {
				hiddenDepth = Math.max(0, hiddenDepth - 1);
			}
			continue;
		}
		if (hiddenDepth > 0) continue;

		if (name === "br") {
			append("\n");
		} else if (name === "blockquote") {
			flush();
			quoteDepth = Math.max(0, quoteDepth + (opening ? 1 : -1));
		} else if (BLOCK_TAGS.has(name)) {
			flush();
		} else if (BOLD_TAGS.has(name)) {
			boldDepth = Math.max(0, boldDepth + (opening ? 1 : -1));
		} else if (ITALIC_TAGS.has(name)) {
			italicDepth = Math.max(0, italicDepth + (opening ? 1 : -1));
		} else if (name === "a") {
			if (opening) hrefs.push(safeHref(attribute(HREF_PATTERN, attrs)));
			else hrefs.pop();
		}
	}
	flush();
	return blocks;
}

export const richBlocksText = (blocks: readonly RichBlock[]): string =>
	blocks.map((block) => block.spans.map((span) => span.text).join("")).join("\n\n");
