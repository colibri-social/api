---
"@colibri-social/appview": minor
---

Reports how much the polyfill hosts. Three new gauges, measured at most every 5 minutes:

- `colibri_polyfill_users`: users with a known hosting mode, labelled by `mode` (`polyfill`, `migrating` or `native`).
- `colibri_polyfill_blobs`: blobs stored for polyfilled users.
- `colibri_polyfill_bytes`: storage polyfilled users take, labelled by `kind`. `blobs` is the size of their blobs in object storage, and `records` is the size of their records in the database.

The Colibri Postgres dashboard shows them in four new panels: polyfilled users, polyfill blobs, total polyfill storage, and storage by kind over time.
