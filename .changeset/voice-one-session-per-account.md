---
"@colibri-social/appview": patch
"@colibri-social/voice": patch
"@colibri-social/lexicons": minor
---

Give each account a single voice session. Joining a voice channel now retires that account's other voice sockets with a `superseded` reason, so a second device takes the call over instead of running alongside it, and nobody can sit in two channels at once. A handover within the same channel keeps the participant record, so the rest of the room sees the media move rather than a leave followed by a rejoin.

Along with it, a set of voice fixes:

- A frame the SFU cannot serve is answered with an error instead of rejecting unhandled, which could take the process down when Sentry was not configured.
- A server mute now pauses every audio producer rather than only the one declaring `mic`, survives the muted account reconnecting, and can be applied before that account carries any media.
- Voice connections release their topic subscriptions when they close, and frames from one socket are handled in order, so a socket can no longer leave a channel claiming it forever.
- A transport mediasoup reports as closed or failed is closed rather than only forgotten, releasing its ports and its producers instead of replaying dead producers to everyone who joins.
- The speaking indicator settles after the debounce window even when no further audio arrives, and clears when a speaker leaves mid-word.
- A room whose worker died is torn down, so presence stops reporting its participants as being in a call.
- `produce`, `consume` and `setSelfState` no longer conjure a participant from a frame naming an unknown transport, which used to announce a phantom join to the whole community.
- Joining replays who is already in the room and what moderation applies to them, and producer frames carry `paused`.
- Presence is claimed before the room is created, so two devices racing to create transports cannot leave one of them live in an untracked room.
- `SFU_ICE_SERVERS` reaches clients through `transportOptions`, so configured STUN and TURN servers are used instead of silently dropped.
