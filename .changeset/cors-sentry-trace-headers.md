---
"@colibri-social/appview": patch
---

Allows the `sentry-trace` and `baggage` request headers in CORS preflights, so browsers can call `com.atproto.identity.resolveHandle` directly and users with DNS-only handles can sign in
