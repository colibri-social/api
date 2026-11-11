---
"@colibri-social/appview": patch
---

Run the main node behind an existing Traefik. Caddy in `docker-compose.scaled.yml` now starts only with the `caddy` profile. `deploy/traefik/compose.traefik.yml` joins the AppView to Traefik's network (`TRAEFIK_NETWORK`, default `dokploy-network`) and routes `PUBLIC_HOST` and `API_HOST` to it with `TRAEFIK_CERT_RESOLVER` (default `letsencrypt`) on `TRAEFIK_ENTRYPOINT` (default `websecure`). The `uptime-kuma` playbook only reloads Caddy where it runs.
