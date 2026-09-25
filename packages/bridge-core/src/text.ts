import type { Facet } from "./client.js";
import { facetsToSource, normalizeWhitespace, parseMarkdown } from "./markdown.js";

export const MAX_TEXT_LENGTH = 2048;

const encoder = new TextEncoder();

export type ColibriText = {
	text: string;
	facets: Facet[];
};

export type Feature = Facet["features"][number];

export type RemoteReference = { kind: "user" | "room"; id: string };

const REFERENCE_PREFIX = "bridge:";

export const referenceUri = (reference: RemoteReference): string =>
	`${REFERENCE_PREFIX}${reference.kind}/${reference.id}`;

export const parseReferenceUri = (uri: string): RemoteReference | null => {
	const match = /^bridge:(user|room)\/(.+)$/.exec(uri);
	return match?.[1] && match[2]
		? { kind: match[1] as RemoteReference["kind"], id: match[2] }
		: null;
};

export const referenceMarkdown = (label: string, reference: RemoteReference): string =>
	`[${label.replace(/[[\]]/g, "")}](${referenceUri(reference)})`;

const isLink = (feature: Feature): feature is Feature & { uri: string } =>
	feature.$type === "social.colibri.beta.richtext.facet#link" && "uri" in feature;

const resolveReferences = (
	facets: Facet[],
	resolve: (reference: RemoteReference) => Feature | null,
): Facet[] =>
	facets.flatMap((facet) => {
		const features = facet.features.flatMap((feature) => {
			if (!isLink(feature) || !feature.uri.startsWith(REFERENCE_PREFIX)) return [feature];
			const reference = parseReferenceUri(feature.uri);
			const resolved = reference ? resolve(reference) : null;
			return resolved ? [resolved] : [];
		});
		return features.length > 0 ? [{ ...facet, features }] : [];
	});

export const markdownToColibri = (
	markdown: string,
	resolve: (reference: RemoteReference) => Feature | null = () => null,
): ColibriText => {
	const parsed = normalizeWhitespace(parseMarkdown(markdown));
	return clampText({
		text: parsed.text,
		facets: resolveReferences(parsed.facets as Facet[], resolve),
	});
};

export const colibriToMarkdown = (
	text: string,
	facets: readonly Facet[] = [],
	refer: (feature: Feature) => RemoteReference | null = () => null,
): string => {
	const { source, atoms } = facetsToSource(text, [...facets]);
	let out = source;
	for (const atom of [...atoms].sort((a, b) => b.start - a.start)) {
		const reference = refer(atom.feature as Feature);
		if (!reference) continue;
		out = `${out.slice(0, atom.start)}${referenceMarkdown(out.slice(atom.start, atom.end), reference)}${out.slice(atom.end)}`;
	}
	return out;
};

const TRUNCATION = "...";

export const clampText = (input: ColibriText, maxLength = MAX_TEXT_LENGTH): ColibriText => {
	if (input.text.length <= maxLength) return input;
	let kept = "";
	for (const char of input.text) {
		if (kept.length + char.length > maxLength - TRUNCATION.length) break;
		kept += char;
	}
	const limit = encoder.encode(kept).length;
	return {
		text: `${kept}${TRUNCATION}`,
		facets: input.facets.filter((facet) => facet.index.byteEnd <= limit),
	};
};
