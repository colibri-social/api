import type { AuthzChange } from "@colibri-social/projections";

export type AuthzChangeListener = (change: AuthzChange) => void;

export type AuthzChanges = {
	publish: AuthzChangeListener;
	deliver: AuthzChangeListener;
	route: (forward: AuthzChangeListener) => void;
	subscribe: (listener: AuthzChangeListener) => () => void;
};

export const createAuthzChanges = (): AuthzChanges => {
	const listeners = new Set<AuthzChangeListener>();
	let forward: AuthzChangeListener | null = null;

	const deliver: AuthzChangeListener = (change) => {
		for (const listener of [...listeners]) listener(change);
	};

	return {
		publish: (change) => {
			if (forward) {
				forward(change);

				return;
			}

			deliver(change);
		},
		deliver,
		route: (next) => {
			forward = next;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};
