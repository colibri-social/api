---
"@colibri-social/lexicons": minor
"@colibri-social/voice": minor
"@colibri-social/appview": minor
---

Adds optional `camera` and `screen` flags to `social.colibri.beta.actor.defs#voiceState`. The AppView sets them from each participant's video producers and sends a voice `update` event to the community when a camera or screen share starts or stops, so clients can show who is sharing in channels they haven't joined.
