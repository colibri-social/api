---
"@colibri-social/blobs": minor
"@colibri-social/space": minor
"@colibri-social/appview": patch
---

`blob.get` streams large blobs while it checks their CID, so the AppView no longer holds whole videos in memory. A CID mismatch found at the end aborts the connection. The blob cache only keeps blobs up to 16 MB, keys entries by DID, space and CID, and shares one upstream fetch between concurrent requests for the same blob. Blobs outside the media types are served as sandboxed `application/octet-stream` downloads, and missing and rejected blobs are logged with a code. `XrpcClient.stream` applies its timeout to the response headers only and aborts a body that sends nothing for `idleTimeoutMs`, 30 seconds by default
