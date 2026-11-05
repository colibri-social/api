---
"@colibri-social/lexicons": patch
"@colibri-social/space": patch
"@colibri-social/space-sync": patch
"@colibri-social/community": patch
"@colibri-social/identity": patch
"@colibri-social/blobs": patch
"@colibri-social/bridge-core": patch
"@colibri-social/appview": patch
---

Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.
