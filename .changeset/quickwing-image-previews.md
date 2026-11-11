---
"@colibri-social/appview": minor
"@colibri-social/blobs": minor
---

Serve image attachments as smaller previews and keep rendered previews on disk.

- Image attachments get a `previewUrl` with the new `timeline` variant: at most 1280 px on the long edge, WebP for still images, and animated WebP or GIF for animated ones. It's signed for the viewer like `url` and served after the same authorization check. Other files get no preview.
- Rendered variants are kept on disk in `BLOB_DISK_CACHE_DIR` (default `./data/blob-cache`, `/data/blob-cache` in the compose stacks) up to `BLOB_DISK_CACHE_MAX_BYTES` (default 10 GB, `0` turns it off), with the least recently used ones removed first. They survive restarts. The in-memory cache stays in front, and originals still stream from the PDS.
- Concurrent requests for the same variant share one render, and at most `BLOB_RENDER_CONCURRENCY` renders run at once (default half the CPU cores).
- `@colibri-social/blobs` adds `DiskVariantCache`, the `timeline` variant, and the `disk` and `renderConcurrency` options on `BlobService`.
- The main node in `docker-compose.scaled.yml` keeps its node secret in the data volume.
