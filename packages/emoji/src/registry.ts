import type { EmojiCollectionKind, EmojiProvider } from "./provider.js";

export type CollectionOwner = {
	provider: EmojiProvider;
	kind: EmojiCollectionKind;
};

export const createEmojiRegistry = (providers: readonly EmojiProvider[], defaultId: string) => {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const byCollection = new Map<string, CollectionOwner>();
	for (const provider of providers) {
		const { item, pack, membership } = provider.collections;
		byCollection.set(item, { provider, kind: "item" });
		if (pack) byCollection.set(pack, { provider, kind: "pack" });
		if (membership) byCollection.set(membership, { provider, kind: "membership" });
	}

	const fallback = byId.get(defaultId);
	if (!fallback) throw new Error(`the default emoji provider ${defaultId} is not registered`);

	return {
		providers,
		defaultProvider: fallback,
		collections: [...byCollection.keys()],
		get: (id: string): EmojiProvider | undefined => byId.get(id),
		forCollection: (collection: string): CollectionOwner | undefined =>
			byCollection.get(collection),
	};
};

export type EmojiRegistry = ReturnType<typeof createEmojiRegistry>;
