import type { AuthzChange } from "@colibri-social/projections";

export type AuthzChangeListener = (change: AuthzChange) => void;

export type AuthzChanges = {
	publish: AuthzChangeListener;
	subscribe: (listener: AuthzChangeListener) => () => void;
};

export const createAuthzChanges = (): AuthzChanges => {
	const listeners = new Set<AuthzChangeListener>();

	return {
		publish: (change) => {
			for (const listener of [...listeners]) listener(change);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};
