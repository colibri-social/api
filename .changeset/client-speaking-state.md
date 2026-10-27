---
"@colibri-social/lexicons": minor
"@colibri-social/voice": minor
"@colibri-social/appview": minor
---

Add the `setSpeaking` voice frame. A client that sends it decides its own speaking state, and the server stops using the audio level for that member. Clients that never send it keep the level-based state. Muting, by the member or a moderator, always clears the speaking state. Every speaking change now also goes out as a `voiceEvent` with `event: "speaking"` on the community's live feed.
