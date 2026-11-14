---
"@colibri-social/lexicons": minor
---

Adds `social.colibri.beta.polyfill.*`, the methods through which the AppView hosts space repos for accounts whose PDS can't host spaces yet, and moves them to the PDS once it can:

- `getStatus` reports where the caller's repos live (`polyfill`, `migrating` or `native`) and whether their PDS supports spaces.
- `applyWrites`, `getRecord` and `listRecords` write and read the caller's hosted repos.
- `uploadBlob` and `getBlob` store and return the caller's attachments.
- `beginMigration`, `listForMigration` and `completeMigration` copy the hosted repos to the PDS and verify each one.

`social.colibri.beta.permissionAccount` now grants all of them.
