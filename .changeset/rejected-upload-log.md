---
"@colibri-social/appview": patch
---

Log a `polyfill.uploadRejected` warning when `social.colibri.beta.polyfill.uploadBlob` answers with an error status. The warning records the response body, the request's content headers, the node that handled it, and the node that forwarded it
