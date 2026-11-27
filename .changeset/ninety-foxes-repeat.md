---
"@colibri-social/appview": minor
"@colibri-social/notifications": patch
---

Forward requests about a community another AppView manages to that AppView, acting for the signed-in user, and relay its answer. A request that was already forwarded is never forwarded again: it gets `NotManagingApp` with the current managing AppView, and the forwarding AppView looks the community up again and retries once. With `FEDERATION_ENABLED=false` such requests get `FederationDisabled`. An AppView that doesn't answer gives `UpstreamFailure`
