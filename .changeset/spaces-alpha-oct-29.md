---
"@colibri-social/lexicons": minor
"@colibri-social/space": minor
"@colibri-social/community": minor
"@colibri-social/appview": minor
---

Update Spaces support to the October 29 alpha (`0.0.0-spaces-alpha-20261029171913`). The vendored atproto lexicons move to `5d88b414` and replace `com.atproto.simplespace` with the `com.atproto.space` lifecycle methods and the `memberspace`, `managedspace` and `personalspace` policies. `PdsClient.createSpace` and `updateSpace` take a single `policy`, built with `memberspacePolicy` or `managedspacePolicy`. Community profile spaces are created as a member space with `publicRead`, and every other community space as a managed space. The AppView serves `com.atproto.managedspace.checkUserAccess`, treats `SpaceNotFound` from `getSpaceCredential` as a refusal, and on startup moves existing profile spaces to the public member space policy.
