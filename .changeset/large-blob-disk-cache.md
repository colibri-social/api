---
"@colibri-social/blobs": patch
"@colibri-social/appview": patch
---

Keep blobs over 16 MB on disk after the first request, so video seeks and repeat plays no longer fetch them from the author's server again. Concurrent requests for the same blob share one download. `BLOB_DISK_ORIGINAL_MAX_BYTES` sets the budget (4 GiB by default, 0 turns it off). QuickTime movies are now served as `video/quicktime` so they play inline.
