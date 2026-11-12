import { afterEach, describe, expect, it } from "vitest";
import { count, type MetricsHandle, observe, record, startMetrics, xrpcMethod } from "./metrics.js";

let handle: MetricsHandle | null = null;

afterEach(async () => {
	await handle?.stop();
	handle = null;
});

describe("xrpcMethod", () => {
	it("reads the NSID from an XRPC path and folds anything else", () => {
		expect(xrpcMethod("/xrpc/social.colibri.beta.channel.getMessages")).toBe(
			"social.colibri.beta.channel.getMessages",
		);
		expect(xrpcMethod("/xrpc/../../etc/passwd")).toBe("other");
		expect(xrpcMethod("/health")).toBeNull();
	});
});

describe("startMetrics", () => {
	it("serves counters, histograms and gauges in the Prometheus format", async () => {
		const port = 19_000 + Math.floor(Math.random() * 1_000);

		handle = startMetrics({ host: "127.0.0.1", port, attributes: { node: "eu-1" } });

		const stop = observe("connections", () => [{ value: 7, attributes: { kind: "events" } }]);

		count("pushDeliveries", { provider: "fcm", outcome: "delivered", type: "message" });
		record("xrpcDuration", 0.2, {
			method: "social.colibri.beta.server.describeServer",
			status: 200,
		});

		let body = "";

		for (let attempt = 0; attempt < 20 && body === ""; attempt += 1) {
			body = await fetch(`http://127.0.0.1:${port}/metrics`)
				.then((response) => response.text())
				.catch(async () => {
					await new Promise((resolve) => setTimeout(resolve, 50));

					return "";
				});
		}

		stop();

		expect(body).toMatch(/colibri_connections\{node="eu-1",kind="events"\} 7/);
		expect(body).toMatch(
			/colibri_push_deliveries_total\{node="eu-1",provider="fcm",outcome="delivered",type="message"\} 1/,
		);
		expect(body).toMatch(
			/colibri_push_deliveries_total\{node="eu-1",provider="apns",outcome="gone",type="read"\} 0/,
		);
		expect(body.match(/^colibri_push_deliveries_total\{/gm)).toHaveLength(36);
		expect(body).toMatch(/colibri_xrpc_duration_seconds_bucket\{.*le="0.25"\} 1/);
	});
});
