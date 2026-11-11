# @colibri-social/blobs

## 0.3.0

### Minor Changes

- 6605f3d: Serve image attachments as smaller previews and keep rendered previews on disk.
  
  - Image attachments get a `previewUrl` with the new `timeline` variant: at most 1280 px on the long edge, WebP for still images, and animated WebP or GIF for animated ones. It's signed for the viewer like `url` and served after the same authorization check. Other files get no preview.
  - Rendered variants are kept on disk in `BLOB_DISK_CACHE_DIR` (default `./data/blob-cache`, `/data/blob-cache` in the compose stacks) up to `BLOB_DISK_CACHE_MAX_BYTES` (default 10 GB, `0` turns it off), with the least recently used ones removed first. They survive restarts. The in-memory cache stays in front, and originals still stream from the PDS.
  - Concurrent requests for the same variant share one render, and at most `BLOB_RENDER_CONCURRENCY` renders run at once (default half the CPU cores).
  - `@colibri-social/blobs` adds `DiskVariantCache`, the `timeline` variant, and the `disk` and `renderConcurrency` options on `BlobService`.
  - The main node in `docker-compose.scaled.yml` keeps its node secret in the data volume.

## 0.2.5

### Patch Changes

- 19be678: Update Spaces support to the November 5 alpha (`0.0.0-spaces-alpha-20261105160032`). STAR archives from `getRepo` use the new control-byte framing through the `@atproto/space` helpers, so the AppView needs a PDS on the same alpha. `@atproto/star` is pinned to the alpha build, because its caret range otherwise resolves to a broken `0.0.0-stage` release. The vendored atproto space lexicons move to `704b9e2a`, which adds `RepoTakendown` and `RepoDeactivated` to `getSpaceCredential` and `listRepos`. A suspended space keeps its synced data and retries, as before.
- Updated dependencies [19be678]
  - @colibri-social/space@0.11.1

## 0.2.4

### Patch Changes

- Updated dependencies [e3aa164]
  - @colibri-social/space@0.11.0

## 0.2.3

### Patch Changes

- Updated dependencies [b3f77f4]
  - @colibri-social/space@0.10.0

## 0.2.2

### Patch Changes

- Updated dependencies [7097dbf]
- Updated dependencies [73d1143]
  - @colibri-social/space@0.9.0

## 0.2.1

### Patch Changes

- Updated dependencies [0b325da]
  - @colibri-social/space@0.8.0

## 0.2.0

### Minor Changes

- 817469f: Serve Space banners as a 2:1 `spaceBanner` image variant so they fill the Space header without being cropped twice

## 0.1.0

### Minor Changes

- 384edf8: `blob.get` streams large blobs while it checks their CID, so the AppView no longer holds whole videos in memory. A CID mismatch found at the end aborts the connection. The blob cache only keeps blobs up to 16 MB, keys entries by DID, space and CID, and shares one upstream fetch between concurrent requests for the same blob. Blobs outside the media types are served as sandboxed `application/octet-stream` downloads, and missing and rejected blobs are logged with a code. `XrpcClient.stream` applies its timeout to the response headers only and aborts a body that sends nothing for `idleTimeoutMs`, 30 seconds by default

### Patch Changes

- Updated dependencies [384edf8]
  - @colibri-social/space@0.7.0

## 0.0.8

### Patch Changes

- Updated dependencies [56da297]
  - @colibri-social/space@0.6.0

## 0.0.7

### Patch Changes

- bb5a859: Serves community pictures and banners from the profile space through per-viewer signed links, and answers a missing public blob with 404.
- Updated dependencies [ef70f83]
  - @colibri-social/space@0.5.0

## 0.0.6

### Patch Changes

- Updated dependencies [6e75d20]
- Updated dependencies [d8e32d1]
  - @colibri-social/space@0.4.0

## 0.0.5

### Patch Changes

- Updated dependencies [1ed3c64]
  - @colibri-social/space@0.3.0

## 0.0.4

### Patch Changes

- Updated dependencies [132dd5a]
  - @colibri-social/space@0.2.1

## 0.0.3

### Patch Changes

- Updated dependencies [152a8fb]
  - @colibri-social/space@0.2.0

## 0.0.2

### Patch Changes

- Updated dependencies [49310eb]
  - @colibri-social/space@0.1.1

## 0.0.1

### Patch Changes

- Updated dependencies [42ec07e]
  - @colibri-social/space@0.1.0
