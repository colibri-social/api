# @colibri-social/notifications

## 1.2.0

### Minor Changes

- 58aea35: Serve threads: a thread space projects to its own table, access follows the parent channel and the thread's own visibility, and the thread methods create, rename, repoint, delete and move messages between spaces. Notifications now check that the recipient may read the space, which stops a mention in a private channel or thread reaching someone outside it.

### Patch Changes

- Updated dependencies [58aea35]
- Updated dependencies [58aea35]
  - @colibri-social/lexicons@2.9.1
  - @colibri-social/appview-db@0.4.0
  - @colibri-social/projections@1.4.0

## 1.1.6

### Patch Changes

- Updated dependencies [305fd99]
  - @colibri-social/lexicons@2.9.0
  - @colibri-social/projections@1.3.5

## 1.1.5

### Patch Changes

- 64d9500: Improve actor hydration, cache handle/identity resolution, fix listMembers `cursor` and `role` parameters usage, `getUnseen` index building improvements, add `space` to `notifications_unseen_idx`
- f0d57a4: Send the routing hints the clients read on a push notification tap. The payload now carries `channelUri`, `messageUri` and, for FCM, a `social.colibri:/channel/...` deep link plus the message body, so a tap can open the right channel and focus the message instead of falling back to the app root
- Updated dependencies [64d9500]
- Updated dependencies [d7c4b6f]
  - @colibri-social/appview-db@0.3.0
  - @colibri-social/lexicons@2.8.0
  - @colibri-social/projections@1.3.4

## 1.1.4

### Patch Changes

- Updated dependencies [eebf5ef]
  - @colibri-social/lexicons@2.7.0
  - @colibri-social/appview-db@0.2.1
  - @colibri-social/projections@1.3.3

## 1.1.3

### Patch Changes

- Updated dependencies [bad9064]
  - @colibri-social/lexicons@2.6.0
  - @colibri-social/projections@1.3.2

## 1.1.2

### Patch Changes

- Updated dependencies [38dc331]
- Updated dependencies [dc9ea5c]
- Updated dependencies [07d1508]
  - @colibri-social/lexicons@2.5.0
  - @colibri-social/projections@1.3.1

## 1.1.1

### Patch Changes

- Updated dependencies [1c863c7]
- Updated dependencies [d175422]
- Updated dependencies [132dd5a]
- Updated dependencies [d2c8938]
  - @colibri-social/lexicons@2.4.0
  - @colibri-social/projections@1.3.0
  - @colibri-social/space@0.2.1

## 1.1.0

### Minor Changes

- 152a8fb: Honor a muted channel, and stay quiet for someone who is already reading the channel the message landed in

### Patch Changes

- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0
  - @colibri-social/projections@1.2.1
  - @colibri-social/lexicons@2.3.0

## 1.0.3

### Patch Changes

- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
- Updated dependencies [efcadc8]
  - @colibri-social/lexicons@2.2.0
  - @colibri-social/projections@1.2.0

## 1.0.2

### Patch Changes

- Updated dependencies [396e6ef]
- Updated dependencies [396e6ef]
  - @colibri-social/lexicons@2.1.0
  - @colibri-social/projections@1.1.0
  - @colibri-social/appview-db@0.2.0

## 1.0.1

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

- bd2a38c: Enforce `hidden` labels server-side instead of forwarding them as advice
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
