import { describe, expect, it, vi } from "vitest";
import { createAuthzChanges } from "./authz-changes.js";

const change = { community: "did:plc:community", collection: "social.colibri.beta.member" };

describe("createAuthzChanges", () => {
	it("delivers straight to listeners until a route is set", () => {
		const changes = createAuthzChanges();
		const listener = vi.fn();

		changes.subscribe(listener);
		changes.publish(change);

		expect(listener).toHaveBeenCalledWith(change);
	});

	it("sends published changes through the route, and only deliver reaches listeners", () => {
		const changes = createAuthzChanges();
		const listener = vi.fn();
		const forward = vi.fn();

		changes.subscribe(listener);
		changes.route(forward);
		changes.publish(change);

		expect(forward).toHaveBeenCalledWith(change);
		expect(listener).not.toHaveBeenCalled();

		changes.deliver(change);

		expect(listener).toHaveBeenCalledWith(change);
	});
});
