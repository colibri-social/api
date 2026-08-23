export const JETSTREAM_SUBSCRIBE_PATH = "/xrpc/network.bsky.jetstream.subscribeEvents";
export const JETSTREAM_SUBPROTOCOL = "xrpc.v1.json";

const LEGACY_SUBSCRIBE_PATH = "/subscribe";

export const jetstreamEndpoint = (configured: string): URL => {
	const url = new URL(configured);
	if (url.pathname === "/" || url.pathname === "") url.pathname = JETSTREAM_SUBSCRIBE_PATH;
	return url;
};

export const isLegacyJetstreamUrl = (configured: string): boolean => {
	try {
		return new URL(configured).pathname.replace(/\/$/, "") === LEGACY_SUBSCRIBE_PATH;
	} catch {
		return false;
	}
};
