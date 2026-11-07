---
"@colibri-social/appview": minor
"@colibri-social/appview-db": minor
"@colibri-social/voice": minor
---

Run voice calls across AppView nodes.

- Each SFU worker listens on one UDP and TCP port through a mediasoup `WebRtcServer`, starting at `SFU_RTC_PORT` (default 40000). `SFU_RTC_MIN_PORT` and `SFU_RTC_MAX_PORT` are removed. The compose file publishes 40000-40031.
- The SFU reads its settings from the AppView config. `SFU_INITIAL_OUTGOING_BITRATE` is part of it now, and `voiceSfuConfigFromEnv` is removed from `@colibri-social/voice`.
- A call runs on one node. `voice_calls` pins it there, and a join on another node answers with `callElsewhere`. A call on a node that stopped reporting moves to the next node someone joins on.
- Who is in a call lives in the new `voice_participants` table, so presence shows voice state from every node and `voice.moderate` reaches a call on any node over the event bus. The main node clears participants of nodes that stopped reporting and announces that they left.
- Server mutes and deafens are stored per Space member in the new `voice_moderation` table. They apply in every voice channel of the Space and last across calls, restarts and nodes until a moderator lifts them.
- A call that grows past `SFU_PARTICIPANTS_PER_WORKER` (default 20) participants per worker takes another worker, up to `SFU_WORKER_COUNT`. Its routers pipe every producer to each other, so everyone still hears everyone. New calls start on the worker with the fewest routers.
- With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, every transport gets Cloudflare TURN credentials valid for 24 hours, next to `SFU_ICE_SERVERS`.
- When a voice node drains, every call gets a `migrationProposal` with the other voice nodes. Participants answer with `rttReport`, and after `VOICE_MIGRATION_NOTICE_SECONDS` (default 60) or a `moveNow` the call moves with `migrateTo` to the node with the lowest worst-case round trip. A node that shuts down tells remaining callers `nodeClosed`. `joined` carries the node ID and region.
- `Database` exposes `primary` for reads that can't wait for a replica.
