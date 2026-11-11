---
"@colibri-social/appview": minor
---

The main node reads the shared settings too. A clustered node without `MAIN_NODE_URL` reads `cluster_config` from its own database at boot with `CREDENTIAL_ENCRYPTION_KEY`, so settings stored with `colibri-admin config set` reach it without being copied into its `.env`. Its own environment still wins, and it starts with only its own settings when the store can't be read.
