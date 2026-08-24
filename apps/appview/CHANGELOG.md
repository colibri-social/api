# @colibri-social/appview

## 2.5.0

### Minor Changes

- b1bbb1a: Scope channel events and live delivery to the people who may read the channel
- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

### Patch Changes

- 38dc331: Sign an attachment's media link for each recipient of a live message event, so a blob in a permissioned space loads without waiting for a reload. Declare the viewer, exp and sig params on social.colibri.beta.blob.get
- dc9ea5c: Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
- b1e2b73: Run each actor's presence transitions in order, so a socket that opens and closes in quick succession can no longer swallow the offline broadcast and leave that member listed as online for everyone else
- dc9ea5c: Default the SFU's RTC port range to 40000-40100, the range the compose file publishes. With neither `SFU_RTC_MIN_PORT` nor `SFU_RTC_MAX_PORT` set, transports took a port from mediasoup's own 10000-59999 default, so almost every candidate pointed at a port nothing forwarded and calls failed to connect.
- f29b7d4: Publish the SFU's media port range for TCP as well as UDP, so the ICE over TCP fallback the SFU advertises can be reached. A port Docker does not forward drops the connection attempt without a reply, which fails ICE and leaves callers in silence.
- 324a3e6: Move commit verification and repo recovery onto worker threads, so a large repo no longer stalls message delivery for every other channel. Set SYNC_WORKER_THREADS to turn it on
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
- Updated dependencies [321e7dc]
- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [dc9ea5c]
- Updated dependencies [324a3e6]
- Updated dependencies [07d1508]
  - @colibri-social/community@2.3.0
  - @colibri-social/space-sync@0.3.0
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1
  - @colibri-social/voice@0.1.1
  - @colibri-social/notifications@1.1.2

## 2.4.0

### Minor Changes

- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

### Patch Changes

- a9cea8f: Give a new community a random handle, so provisioning no longer fails on the PDS handle length limit
- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- 88810f6: Serve your own profile straight from your PDS, so a change you just saved comes back instead of the cached one
- Updated dependencies [a9cea8f]
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [a35adfc]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/community@2.2.1
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space-sync@0.2.1
  - @colibri-social/space@0.2.1
  - @colibri-social/notifications@1.1.1
  - @colibri-social/blobs@0.0.4

## 2.3.1

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/community@2.2.0
  - @colibri-social/space@0.2.0
  - @colibri-social/identity@0.0.1
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0
  - @colibri-social/notifications@1.1.0
  - @colibri-social/space-sync@0.2.0
  - @colibri-social/blobs@0.0.3

## 2.3.0

### Minor Changes

- 22ad3fb: Announce channel, category, role, community, membership, profile and status changes to the community over the socket, and answer every voice frame a client waits on
- 22ad3fb: Keep a channel's visibility lists when projecting its record, and tell the community over the socket when a channel or category changes
- 22ad3fb: Resolve a community's handle from its DID document, and log every 5xx an XRPC route produces
- b5c5283: Answer CORS on `/xrpc`, including on error responses, and stop the catchall from shadowing the blob route
- 9c7e4d2: Serve embed images and video through the AppView again, answer handle and DID resolution for clients, deliver push notifications, honor muted channels, tell a peer when it is disconnected from a call, report errors to Sentry, and report progress while migrating
- 22ad3fb: Keep using a space credential that is still valid when nothing can mint a delegation token for it
- 912b790: Handle the typing and viewChannel frames, keep notifications quiet for the channel someone is reading, and send the notification, seen, application, moderation and community-progress events that were declared but never published
- 912b790: Report progress while migrating a legacy community, and announce a label the moment it is applied so a hidden message disappears live
- 22ad3fb: Add a `preferencesEvent` sync frame and send it to an actor's own devices when their preferences change
- 22ad3fb: Derive an actor's online state from their open event sockets, and broadcast it to the communities they belong to
- 22ad3fb: Sweep a channel space against its member list, so a member's repo is found and kept even when the authority's writer set leaves it out

### Patch Changes

- 9c7e4d2: Honor a role's per-channel overrides when checking `label.apply`, and keep every env file out of the Docker build context

## 2.2.0

### Minor Changes

- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- efcadc8: Let a mute name a channel
- efcadc8: Follow profile records on Jetstream
- 0e3df75: Record every space in the `spaces` table at the moment it is created, so the sync
  engine can find it
- efcadc8: Refuse to boot on a bare-IP `did:web`
- efcadc8: Separate a peer's own mute from a moderator's

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [0e3df75]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/community@2.1.0
  - @colibri-social/projections@1.2.0
  - @colibri-social/voice@0.1.0
  - @colibri-social/notifications@1.0.3

## 2.1.0

### Minor Changes

- 396e6ef: Report `software` and `flavor` from `server.describeServer` again, so a client can tell a Colibri AppView from any other host
- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0
  - @colibri-social/community@2.0.1
  - @colibri-social/notifications@1.0.2

## 2.0.0

### Major Changes

- 229dde3: Close the `blob.get` authorization hole without breaking browser media, also fixes the cache headers
- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/community@2.0.0
  - @colibri-social/appview-db@0.1.0
  - @colibri-social/notifications@1.0.1
  - @colibri-social/projections@1.0.1

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1
  - @colibri-social/space-sync@0.1.1
  - @colibri-social/projections@1.0.0
  - @colibri-social/community@1.0.0
  - @colibri-social/notifications@1.0.0
  - @colibri-social/blobs@0.0.2

## 0.1.0

### Minor Changes

- 42ec07e: Initial release

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
  - @colibri-social/space-sync@0.1.0
  - @colibri-social/community@0.0.1
  - @colibri-social/notifications@0.0.1
  - @colibri-social/projections@0.0.1
  - @colibri-social/blobs@0.0.1
