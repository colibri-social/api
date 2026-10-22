# @colibri-social/blobs

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
