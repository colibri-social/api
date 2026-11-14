---
"@colibri-social/appview": minor
"@colibri-social/blobs": minor
---

Stores attachments for accounts whose repos the AppView hosts in an S3-compatible bucket.

- `social.colibri.beta.polyfill.uploadBlob` stores up to 75 MB under the raw sha256 CID and returns a blob ref. Without a bucket it fails with `BlobStorageUnavailable`.
- `social.colibri.beta.polyfill.getBlob` returns a blob to the account that stored it.
- `social.colibri.beta.blob.get` serves stored blobs to other members from the bucket, with the same CID check, previews and ranges.
- Blobs no record references within 24 hours are deleted.

Set `POLYFILL_S3_BUCKET`, `POLYFILL_S3_ACCESS_KEY_ID` and `POLYFILL_S3_SECRET_ACCESS_KEY` to turn storage on. `POLYFILL_S3_ENDPOINT`, `POLYFILL_S3_REGION` and `POLYFILL_S3_FORCE_PATH_STYLE` point it at a host other than AWS.

`@colibri-social/blobs` adds `S3BlobBucket`, `MemoryBlobBucket`, `blobBucketKey` and a `polyfill` option on `BlobService` that serves blobs from such a bucket before asking the author's host.
