import { EventEmitter } from "node:events";

export type EventMap = Record<string, unknown[]>;

export class TypedEmitter<Events extends EventMap> {
	private readonly emitter = new EventEmitter();

	on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
		this.emitter.on(event, listener as (...args: unknown[]) => void);
		return this;
	}

	once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
		this.emitter.once(event, listener as (...args: unknown[]) => void);
		return this;
	}

	off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
		this.emitter.off(event, listener as (...args: unknown[]) => void);
		return this;
	}

	removeAllListeners<K extends keyof Events & string>(event?: K): this {
		this.emitter.removeAllListeners(event);
		return this;
	}

	listenerCount<K extends keyof Events & string>(event: K): number {
		return this.emitter.listenerCount(event);
	}

	protected emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
		return this.emitter.emit(event, ...args);
	}
}
