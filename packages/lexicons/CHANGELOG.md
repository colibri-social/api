# @colibri-social/lexicons

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
