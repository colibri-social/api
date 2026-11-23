---
"@colibri-social/appview": minor
---

Answer to more than one AppView DID

`APPVIEW_DID_ALIASES` takes a comma-separated list of extra `did:web` DIDs. Service-auth tokens addressed to an alias, with any of the AppView's service fragments, pass the audience check. `/.well-known/did.json` returns the document for the requesting host: an alias host gets a document with the alias as its id and service endpoints on that host, and any other host gets the primary document.
