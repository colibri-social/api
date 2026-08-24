# @colibri-social/space-sync

## 0.2.1

### Patch Changes

- d175422: Deliver messages as soon as they are written instead of sometimes waiting for the next sweep, by no longer dropping a write notification that arrives while a sync is already running, renewing the notify registration on its own schedule, and publishing a message before its notifications are indexed
- Updated dependencies [132dd5a]
  - @colibri-social/space@0.2.1

## 0.2.0

### Minor Changes

- 152a8fb: Let a store name the repos a space expects, so a sweep keeps a member's repo even when the authority's writer set leaves it out

### Patch Changes

- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0

## 0.1.1

### Patch Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace
- Updated dependencies [49310eb]
  - @colibri-social/space@0.1.1

## 0.1.0

### Minor Changes

- 42ec07e: Initial release

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/space@0.1.0
