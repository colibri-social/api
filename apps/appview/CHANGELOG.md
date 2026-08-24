# @colibri-social/appview

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
