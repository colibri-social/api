export const mapWithConcurrency = async <T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	if (items.length === 0) return [];

	const requested = Number.isFinite(limit) ? Math.floor(limit) : items.length;
	const bound = Math.max(1, Math.min(requested, items.length));
	const results = new Array<R>(items.length);
	let next = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index] as T, index);
		}
	};

	await Promise.all(Array.from({ length: bound }, worker));
	return results;
};
