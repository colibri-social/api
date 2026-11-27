---
"@colibri-social/appview": patch
---

Forwards requests to the managing AppView with the same size limits this AppView applies to its own handlers. `polyfill.uploadBlob` bodies go up to 75 MB, other bodies up to 20 MB, and JSON bodies up to 1 MB. Forwarded answers from `polyfill.getBlob` go up to 75 MB and from `blob.get` up to 100 MB, and other answers up to 32 MB.
