import { describe, expect, it } from "vitest";
import { parseImageRef, resolveImage, VERSION_LABEL } from "./image-source.js";

const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

type Route = (request: { url: URL; headers: Headers }) => Response;

const fakeRegistry = (routes: Record<string, Route>) => {
	const calls: string[] = [];
	const request = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const key = `${url.host}${url.pathname}`;

		calls.push(key);

		const route = routes[key];

		return route
			? route({ url, headers: new Headers(init?.headers) })
			: new Response("missing", { status: 404 });
	}) as typeof fetch;

	return { request, calls };
};

const json = (body: unknown, headers: Record<string, string> = {}) => {
	return new Response(JSON.stringify(body), { status: 200, headers });
};

describe("parseImageRef", () => {
	it("reads a GHCR tag", () => {
		expect(parseImageRef("ghcr.io/colibri-social/api:stable")).toEqual({
			registry: "ghcr.io",
			repository: "colibri-social/api",
			reference: "stable",
			name: "ghcr.io/colibri-social/api",
		});
	});

	it("reads a digest, a registry port and Docker Hub names", () => {
		expect(parseImageRef("localhost:5000/api@sha256:abc").reference).toBe("sha256:abc");
		expect(parseImageRef("localhost:5000/api").registry).toBe("localhost:5000");
		expect(parseImageRef("postgres:18-alpine")).toMatchObject({
			registry: "registry-1.docker.io",
			repository: "library/postgres",
			reference: "18-alpine",
		});
	});
});

describe("resolveImage", () => {
	it("follows the token challenge, picks amd64 and reads the version label", async () => {
		const registry = fakeRegistry({
			"ghcr.io/v2/colibri-social/api/manifests/stable": ({ headers }) =>
				headers.get("authorization") === "Bearer t1"
					? json(
							{
								mediaType: INDEX,
								manifests: [
									{ digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
									{ digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
								],
							},
							{ "docker-content-digest": "sha256:top" },
						)
					: new Response("", {
							status: 401,
							headers: {
								"www-authenticate":
									'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:colibri-social/api:pull"',
							},
						}),
			"ghcr.io/token": ({ url, headers }) => {
				expect(url.searchParams.get("scope")).toBe("repository:colibri-social/api:pull");
				expect(headers.get("authorization")).toBe(
					`Basic ${Buffer.from("colibri:secret").toString("base64")}`,
				);

				return json({ token: "t1" });
			},
			"ghcr.io/v2/colibri-social/api/manifests/sha256:amd": () =>
				json({ mediaType: MANIFEST, config: { digest: "sha256:cfg" } }),
			"ghcr.io/v2/colibri-social/api/blobs/sha256:cfg": ({ headers }) => {
				expect(headers.get("authorization")).toBe("Bearer t1");

				return new Response(null, {
					status: 307,
					headers: { location: "https://blobs.example/cfg" },
				});
			},
			"blobs.example/cfg": ({ headers }) => {
				expect(headers.get("authorization")).toBeNull();

				return json({ config: { Labels: { [VERSION_LABEL]: "0.9.0" } } });
			},
		});

		const resolved = await resolveImage("ghcr.io/colibri-social/api:stable", {
			fetch: registry.request,
			credentials: { user: "colibri", token: "secret" },
		});

		expect(resolved).toEqual({
			digest: "sha256:top",
			version: "0.9.0",
			pinned: "ghcr.io/colibri-social/api@sha256:top",
		});
	});

	it("reports an image without a version label", async () => {
		const registry = fakeRegistry({
			"ghcr.io/v2/a/b/manifests/stable": () =>
				json({ mediaType: MANIFEST, config: { digest: "sha256:cfg" } }),
			"ghcr.io/v2/a/b/blobs/sha256:cfg": () => json({ config: { Labels: null } }),
		});

		const resolved = await resolveImage("ghcr.io/a/b:stable", { fetch: registry.request });

		expect(resolved.version).toBeNull();
		expect(resolved.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("fails on a missing tag", async () => {
		const registry = fakeRegistry({});

		await expect(resolveImage("ghcr.io/a/b:nope", { fetch: registry.request })).rejects.toThrow(
			/404/,
		);
	});
});
