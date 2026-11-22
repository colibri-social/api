---
"@colibri-social/lexicons": minor
"@colibri-social/bridge-core": minor
"@colibri-social/appview": minor
"@colibri-social/community": minor
"@colibri-social/appview-db": minor
"@colibri-social/projections": minor
---

Bridges that set up rooms with commands, such as Lightning, can connect to a community without a pairing code. `social.colibri.beta.bridge.install` takes a community and the bridge's handle or DID and writes a registration with platform `external`, the community DID as its remote space, and no linked or open channels. It answers `BridgeNotFound` when the handle or DID doesn't resolve and `AlreadyRegistered` when the bridge is already installed.

Registrations gain an optional `channels` list of open channels, set through `bridge.update`. A bridge may read, subscribe to and post in an open channel and in its unrestricted threads without a room on the other service. `links` keep working as before.

`social.colibri.beta.bridge.listChannels` lists a community's text channels that every member can read to the bridge holding the registration, with `viewer.canRead` and `viewer.canPost` set for the channels open to it. `permissionBridge` includes it, and `permissionCommunity` includes `bridge.install`. In `@colibri-social/bridge-core`, `ColibriClient.listChannels` calls it and `BridgeContext` gains `channels(community, registration)`.
