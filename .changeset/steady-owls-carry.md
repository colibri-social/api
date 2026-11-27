---
"@colibri-social/lexicons": minor
"@colibri-social/appview-db": patch
"@colibri-social/projections": patch
"@colibri-social/appview": patch
---

Add per-group sound volumes and keep polyfilled blobs readable while the main node drains:

- `social.colibri.beta.actor.clientPreferences` and `actor.defs#clientPreferences` have a `soundVolumes` object (`actor.defs#soundVolumes`) with a volume in percent for the `ping`, `presence`, `mic` and `video` sound groups. The AppView stores and returns it with the other client preferences.
- Every node reads and writes SeaweedFS directly at `POLYFILL_S3_CLUSTER_ENDPOINT` and falls back to reading through the main node when SeaweedFS can't be reached. The SeaweedFS bucket, region, keys and path style setting are shared cluster config, so a failover node holding the main role serves blobs, accepts uploads and sweeps unreferenced blobs.
