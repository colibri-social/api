type AnyListener = (...args: readonly unknown[]) => void;

export type EventMap = Record<string, (...args: never[]) => void>;

export class Emitter<Events extends EventMap> {
	private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

	on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
		const set = this.listeners.get(event) ?? new Set<AnyListener>();
		set.add(listener as unknown as AnyListener);
		this.listeners.set(event, set);
		return () => {
			set.delete(listener as unknown as AnyListener);
		};
	}

	emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}
}
