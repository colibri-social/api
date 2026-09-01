# @colibri-social/lexicons

## 2.9.0

### Minor Changes

- 305fd99: Add the thread space type, the thread and follow records, the thread methods, and the `moved` label that serves a message from another space

## 2.8.0

### Minor Changes

- d7c4b6f: Stop invitations from bypassing join approval

## 2.7.0

### Minor Changes

- eebf5ef: Show what someone is listening to when they turn on shareActivity, read from the teal.fm records on their own account

## 2.6.0

### Minor Changes

- bad9064: Add an optional `indent` to `social.colibri.beta.richtext.facet#list` so nested list items can carry their depth

## 2.5.0

### Minor Changes

- 07d1508: Give each account a single voice session. Joining a voice channel now retires that account's other voice sockets with a `superseded` reason, so a second device takes the call over instead of running alongside it, and nobody can sit in two channels at once. A handover within the same channel keeps the participant record, so the rest of the room sees the media move rather than a leave followed by a rejoin.
  
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

### Patch Changes

- 38dc331: Sign an attachment's media link for each recipient of a live message event, so a blob in a permissioned space loads without waiting for a reload. Declare the viewer, exp and sig params on social.colibri.beta.blob.get

## 2.4.0

### Minor Changes

- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

## 2.3.0

### Minor Changes

- 152a8fb: Publish the `sync.defs#preferencesEvent` and `voice.defs#disconnected` frames, which shipped in the AppView but never reached the package

## 2.2.0

### Minor Changes

- efcadc8: Type `voice.defs#transportOptions.iceCandidates` as an array of unknown
- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- efcadc8: Let a mute name a channel
- efcadc8: Separate a peer's own mute from a moderator's

## 2.1.0

### Minor Changes

- 396e6ef: Report `software` and `flavor` from `server.describeServer` again, so a client can tell a Colibri AppView from any other host
- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

## 2.0.0

### Major Changes

- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice

## 0.1.0

### Minor Changes

- 42ec07e: Initial release
