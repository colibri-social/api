---
"@colibri-social/appview": patch
---

Give `PUBLIC_HOST` and `API_HOST` their own Traefik routers, so each name gets its own certificate. With one router, a failed challenge for the API host behind the Cloudflare load balancer also left the node's own name without a certificate.
