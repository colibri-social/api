# @colibri-social/community

## 2.4.0

### Minor Changes

- d7c4b6f: Stop invitations from bypassing join approval

### Patch Changes

- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/identity@0.1.0
  - @colibri-social/lexicons@2.8.0
  - @colibri-social/projections@1.3.4

## 2.3.2

### Patch Changes

- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1
  - @colibri-social/projections@1.3.3

## 2.3.1

### Patch Changes

- Updated dependencies [bad9064]
  - @colibri-social/lexicons@2.6.0
  - @colibri-social/projections@1.3.2

## 2.3.0

### Minor Changes

- 321e7dc: Tell every member when a community is deleted and drop its data straight away, so it stops being listed and stops being served the moment its owner deletes it instead of lingering until its PDS reports the deletion. Deleting a community now also deletes its channel spaces, and a community whose profile space disappears out of band is reconciled the same way.

### Patch Changes

- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [07d1508]
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1

## 2.2.1

### Patch Changes

- a9cea8f: Give a new community a random handle, so provisioning no longer fails on the PDS handle length limit
- a35adfc: Let members with role.manage edit their own roles, granting and revoking any role below their own position
- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space@0.2.1

## 2.2.0

### Minor Changes

- 152a8fb: Report progress while migrating a legacy community, find one from read cursors and message history when nothing else names it, and honor a role's per-channel overrides when checking `label.apply`

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0
  - @colibri-social/identity@0.0.1
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0

## 2.1.0

### Minor Changes

- efcadc8: Make community migration work against a real legacy repo, and give it a picker
- 0e3df75: Record every space in the `spaces` table at the moment it is created, so the sync
  engine can find it

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/projections@1.2.0

## 2.0.1

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0

## 2.0.0

### Major Changes

- 229dde3: Make cross-AppView communities discoverable, and let a community bring its own DID

### Minor Changes

- a39c928: Give communities a working picture and banner write path

### Patch Changes

- Updated dependencies [a39c928]
- Updated dependencies [229dde3]
  - @colibri-social/lexicons@2.0.0
  - @colibri-social/appview-db@0.1.0
  - @colibri-social/projections@1.0.1

## 1.0.0

### Major Changes

- 49310eb: Move every Colibri schema to the `social.colibri.beta.*` namespace

### Patch Changes

- Updated dependencies [49310eb]
- Updated dependencies [bd2a38c]
  - @colibri-social/lexicons@1.0.0
  - @colibri-social/space@0.1.1
  - @colibri-social/projections@1.0.0

## 0.0.1

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/lexicons@0.1.0
  - @colibri-social/space@0.1.0
  - @colibri-social/projections@0.0.1
