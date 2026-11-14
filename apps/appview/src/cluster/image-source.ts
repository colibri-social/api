import { createHash } from "node:crypto";

export const VERSION_LABEL = "org.opencontainers.image.version";

export const MIGRATIONS_LABEL = "social.colibri.migrations";

const INDEX_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
];

const MANIFEST_TYPES = [
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
];

const DOCKER_HUB = "registry-1.docker.io";

export type ImageRef = {
	registry: string;
	repository: string;
	reference: string;
	name: string;
};

export type ResolvedImage = {
	digest: string;
	version: string | null;
	migrations: number | null;
	pinned: string;
};

export type RegistryCredentials = {
	user: string;
	token: string;
};

export type ResolveImageOptions = {
	fetch?: typeof fetch;
	credentials?: RegistryCredentials | undefined;
	platform?: { os: string; architecture: string };
};

type Descriptor = {
	digest: string;
	mediaType?: string;
	platform?: { os?: string; architecture?: string };
};

type Manifest = {
	mediaType?: string;
	manifests?: Descriptor[];
	config?: Descriptor;
};

const isRegistryHost = (segment: string): boolean => {
	return segment.includes(".") || segment.includes(":") || segment === "localhost";
};

export const parseImageRef = (image: string): ImageRef => {
	const [withoutDigest = "", digest] = image.split("@");
	const slash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.lastIndexOf(":");
	const hasTag = colon > slash;
	const name = hasTag ? withoutDigest.slice(0, colon) : withoutDigest;
	const tag = hasTag ? withoutDigest.slice(colon + 1) : "latest";
	const [first = "", ...rest] = name.split("/");

	if (name === "") {
		throw new Error(`${image} is not an image reference`);
	}

	if (rest.length > 0 && isRegistryHost(first)) {
		return {
			registry: first,
			repository: rest.join("/"),
			reference: digest ?? tag,
			name,
		};
	}

	return {
		registry: DOCKER_HUB,
		repository: rest.length === 0 ? `library/${first}` : name,
		reference: digest ?? tag,
		name,
	};
};

export const pinnedImage = (ref: ImageRef, digest: string): string => {
	return `${ref.name}@${digest}`;
};

const challengeParams = (header: string): Record<string, string> => {
	const params: Record<string, string> = {};

	for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
		const [, key, value] = match;

		if (key && value !== undefined) params[key] = value;
	}

	return params;
};

export const migrationCount = (label: string | undefined): number | null => {
	if (label === undefined || !/^\d+$/.test(label)) {
		return null;
	}

	return Number(label);
};

export const resolveImage = async (
	image: string,
	options: ResolveImageOptions = {},
): Promise<ResolvedImage> => {
	const request = options.fetch ?? fetch;
	const platform = options.platform ?? { os: "linux", architecture: "amd64" };
	const ref = parseImageRef(image);
	const base = `https://${ref.registry}/v2/${ref.repository}`;
	let bearer: string | null = null;

	const authenticate = async (challenge: string | null): Promise<void> => {
		const params = challengeParams(challenge ?? "");

		if (!params.realm) {
			throw new Error(`${ref.registry} asked for credentials without a token realm`);
		}

		const url = new URL(params.realm);

		if (params.service) url.searchParams.set("service", params.service);
		url.searchParams.set("scope", params.scope ?? `repository:${ref.repository}:pull`);

		const basic = options.credentials
			? Buffer.from(`${options.credentials.user}:${options.credentials.token}`).toString("base64")
			: null;

		const response = await request(url, {
			headers: basic ? { authorization: `Basic ${basic}` } : {},
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(`${ref.registry} refused a pull token with ${response.status}`);
		}

		const body = (await response.json()) as {
			token?: string;
			access_token?: string;
		};

		bearer = body.token ?? body.access_token ?? null;

		if (!bearer) {
			throw new Error(`${ref.registry} sent no pull token`);
		}
	};

	const get = async (path: string, accept: string[]): Promise<Response> => {
		const send = () => {
			return request(`${base}${path}`, {
				headers: {
					accept: accept.join(", "),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
				},
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
			});
		};

		let response = await send();

		if (response.status === 401) {
			await authenticate(response.headers.get("www-authenticate"));
			response = await send();
		}

		const location = response.headers.get("location");

		if (response.status >= 300 && response.status < 400 && location) {
			response = await request(new URL(location, base), {
				signal: AbortSignal.timeout(15_000),
			});
		}

		if (!response.ok) {
			throw new Error(`${ref.registry} answered ${response.status} for ${ref.repository}${path}`);
		}

		return response;
	};

	const top = await get(`/manifests/${ref.reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
	const topBody = Buffer.from(await top.arrayBuffer());
	const digest =
		top.headers.get("docker-content-digest") ??
		`sha256:${createHash("sha256").update(topBody).digest("hex")}`;
	let manifest = JSON.parse(topBody.toString("utf8")) as Manifest;
	const mediaType = manifest.mediaType ?? top.headers.get("content-type") ?? "";

	if (INDEX_TYPES.includes(mediaType) || manifest.manifests) {
		const match = manifest.manifests?.find(
			(entry) =>
				entry.platform?.os === platform.os &&
				entry.platform?.architecture === platform.architecture,
		);

		if (!match) {
			throw new Error(
				`${image} has no ${platform.os}/${platform.architecture} image in its manifest list`,
			);
		}

		manifest = (await (await get(`/manifests/${match.digest}`, MANIFEST_TYPES)).json()) as Manifest;
	}

	const configDigest = manifest.config?.digest;
	const config = configDigest
		? ((await (await get(`/blobs/${configDigest}`, ["*/*"])).json()) as {
				config?: { Labels?: Record<string, string> | null };
			})
		: null;

	const labels = config?.config?.Labels ?? {};

	return {
		digest,
		version: labels[VERSION_LABEL] ?? null,
		migrations: migrationCount(labels[MIGRATIONS_LABEL]),
		pinned: pinnedImage(ref, digest),
	};
};
