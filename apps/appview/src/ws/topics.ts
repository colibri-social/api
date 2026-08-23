export type Topic = string;

export const communityTopic = (did: string): Topic => `community:${did}`;
export const channelTopic = (space: string): Topic => `channel:${space}`;
export const userTopic = (did: string): Topic => `user:${did}`;

export class TopicIndex<T> {
	private readonly byTopic = new Map<Topic, Set<T>>();
	private readonly bySubscriber = new Map<T, Set<Topic>>();

	subscribe(subscriber: T, topics: Iterable<Topic>): void {
		const held = this.bySubscriber.get(subscriber) ?? new Set<Topic>();
		for (const topic of topics) {
			held.add(topic);
			const members = this.byTopic.get(topic) ?? new Set<T>();
			members.add(subscriber);
			this.byTopic.set(topic, members);
		}
		this.bySubscriber.set(subscriber, held);
	}

	unsubscribe(subscriber: T, topics: Iterable<Topic>): void {
		const held = this.bySubscriber.get(subscriber);
		if (!held) return;
		for (const topic of topics) {
			held.delete(topic);
			const members = this.byTopic.get(topic);
			if (!members) continue;
			members.delete(subscriber);
			if (members.size === 0) this.byTopic.delete(topic);
		}
	}

	forget(subscriber: T): void {
		const held = this.bySubscriber.get(subscriber);
		if (held) this.unsubscribe(subscriber, [...held]);
		this.bySubscriber.delete(subscriber);
	}

	topicsOf(subscriber: T): Topic[] {
		return [...(this.bySubscriber.get(subscriber) ?? [])];
	}

	subscribersOf(topic: Topic): Iterable<T> {
		return this.byTopic.get(topic) ?? [];
	}

	get size(): number {
		return this.bySubscriber.size;
	}
}
