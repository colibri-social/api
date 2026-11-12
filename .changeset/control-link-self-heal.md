---
"@colibri-social/appview": patch
---

Sub-nodes keep their control link to the main node healthy on their own. A node that hands off the main role closes every control link, so sub-nodes dial the new main node. A sub-node now retries after the main node refuses its link, drops a link that hears no ping for 30 seconds, gives up on a handshake after 10 seconds, and moves its link when the registry names a different main node. Rollouts that wait for a missing link log the node's link history and heartbeat, and a forced rollout that gives up names the missing link as the cause.
