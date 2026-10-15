---
"@colibri-social/lexicons": minor
"@colibri-social/appview": minor
"@colibri-social/bridge-core": minor
"@colibri-social/bridge-discord": minor
---

Lets the other side of a bridge disconnect it. `/colibri disconnect` disconnects a Discord server from Colibri, with an optional `community` option that autocompletes the communities the server is paired with. `BridgeContext` gains `connections()`, which lists a remote space's registrations, and `disconnect()`, which leaves all of them or the one community given and counts a registration already revoked in Colibri as disconnected. Bridge registration views carry an optional `communityName`.
