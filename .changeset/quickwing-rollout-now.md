---
"@colibri-social/appview": patch
"@colibri-social/admin": patch
---

Add `colibri-admin rollout now [--grace 2m]`. It resumes paused rollouts and updates every node to the `stable` image at once, one at a time under the quorum rule. Each node drains for the given grace in place of `DRAIN_GRACE_MINUTES`, so clients and calls move to other nodes before it restarts, and the main node stops itself after the same grace. A node that quorum holds back is retried every 10 seconds for up to 10 minutes.
