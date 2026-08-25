# @colibri-social/projections

## 1.3.2

### Patch Changes

- Updated dependencies [bad9064]
  - @colibri-social/lexicons@2.6.0

## 1.3.1

### Patch Changes

- dc9ea5c: Reconcile a mute by its subject rather than its record key, so the immediate `actor.putMutes` push and the later repo sync of the same mute no longer collide on the one-mute-per-subject index and strand the user's preferences space with an unapplied cursor
- Updated dependencies [38dc331]
- Updated dependencies [07d1508]
  - @colibri-social/lexicons@2.5.0

## 1.3.0

### Minor Changes

- d2c8938: Gate voice joins on the same permission as posting, and disconnect a participant whose access changes mid-call

### Patch Changes

- 1c863c7: Keep a community picture, banner and message attachment after it is saved, by converting blob references between their json and lexicon forms at every boundary
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/space@0.2.1

## 1.2.1

### Patch Changes

- 152a8fb: Keep a channel's `visibleToRoles` and `visibleToMembers` when projecting its record
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0
  - @colibri-social/lexicons@2.3.0

## 1.2.0

### Minor Changes

- efcadc8: Let a mute name a channel

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0

## 1.1.0

### Minor Changes

- 396e6ef: Store a favourited GIF as the whole `embed.defs#gifView`, because an identifier cannot be turned back into one

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/appview-db@0.2.0

## 1.0.1

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/appview-db@0.1.0

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1

## 0.0.1

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
