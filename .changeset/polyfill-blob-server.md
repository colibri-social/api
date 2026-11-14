---
"@colibri-social/appview": minor
---

The compose files can run a SeaweedFS bucket server for attachments of people whose server can't host spaces yet. Turn it on with `COMPOSE_PROFILES=blobs` on the main node, and set `POLYFILL_S3_BUCKET`, `POLYFILL_S3_ACCESS_KEY_ID` and `POLYFILL_S3_SECRET_ACCESS_KEY`. The AppView creates the bucket on the first upload. Sub nodes get the same settings when they're provisioned, and reach the main node's bucket over the tailnet on port 8333.
