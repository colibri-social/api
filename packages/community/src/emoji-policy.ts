export const CUSTOM_EMOJI_FEATURE = "social.colibri.beta.richtext.facet#customEmoji";

export type CustomEmojiPolicy = "all" | "local" | "none";

export const customEmojiPolicy = (value: unknown): CustomEmojiPolicy =>
	value === "local" || value === "none" ? value : "all";

const repoOf = (uri: string): string =>
	uri.startsWith("at://") ? (uri.slice(5).split("/")[0] ?? "") : "";

export const allowsCustomEmoji = (
	policy: CustomEmojiPolicy,
	community: string,
	uri: unknown,
): boolean => {
	if (policy === "none" || typeof uri !== "string") return false;
	return policy === "all" || repoOf(uri) === community;
};

type FacetLike = { features?: readonly unknown[] } & Record<string, unknown>;

const isCustomEmoji = (feature: unknown): feature is { uri?: unknown } =>
	typeof feature === "object" &&
	feature !== null &&
	(feature as { $type?: unknown }).$type === CUSTOM_EMOJI_FEATURE;

export const filterCustomEmojiFacets = <T extends FacetLike>(
	facets: readonly T[] | undefined,
	policy: CustomEmojiPolicy,
	community: string,
): T[] | undefined => {
	if (!facets || policy === "all") return facets ? [...facets] : undefined;
	const kept = facets.flatMap((facet) => {
		const features = facet.features ?? [];
		const allowed = features.filter(
			(feature) => !isCustomEmoji(feature) || allowsCustomEmoji(policy, community, feature.uri),
		);
		if (allowed.length === features.length) return [facet];
		return allowed.length > 0 ? [{ ...facet, features: allowed }] : [];
	});
	return kept.length > 0 ? kept : undefined;
};
