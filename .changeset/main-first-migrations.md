---
"@colibri-social/appview": patch
---

Rollouts update the main node first when a release brings database migrations, so other nodes no longer start against an old schema. Nodes without the main role wait at startup until the main node has applied every migration they know.
