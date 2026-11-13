---
"@colibri-social/lexicons": minor
---

Adds lexicons for four methods the AppView serves:

- `social.colibri.beta.sync.subscribeEvents`, the live updates WebSocket. Its messages are the server frames in `social.colibri.beta.sync.defs`.
- `social.colibri.beta.voice.subscribeSignals`, the voice signaling WebSocket. Its messages are the server frames in `social.colibri.beta.voice.defs`.
- `social.colibri.beta.embed.getImage` and `getVideo`, which proxy link embed media through signed URLs.

`social.colibri.beta.permissionMessaging` now grants all four.
