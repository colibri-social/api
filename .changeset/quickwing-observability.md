---
"@colibri-social/appview": minor
"@colibri-social/voice": minor
"@colibri-social/space-sync": minor
"@colibri-social/telemetry": minor
---

Report metrics, traces and logs, and send an anonymous daily heartbeat.

- The AppView serves Prometheus metrics on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `0` turns them off), labeled with the node and region: XRPC duration by method and status, client sockets, Jetstream lag and events, the space sync queue, lag and failures, push deliveries by provider and outcome, drain state, write mode and queued writes, calls and participants, SFU worker CPU, bitrate, packet loss and transports by ICE state, and TURN credential requests.
- Sentry traces every request except `/health` and keeps those over 1 second, those that failed, and `SENTRY_TRACES_SAMPLE_RATE` (default 0.1) of the rest. Voice joins, transport setup, space repo syncs and push sends get their own spans. Logs at info and above go to Sentry Logs. Clustered nodes tag events with their ID, region and roles.
- The main node sends an anonymous heartbeat once a day to `COLIBRI_TELEMETRY_URL` (default `https://telemetry.colibri.social/v1/heartbeat`), an hour after the first start logs a notice. Counts are rounded into ranges. `COLIBRI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turns it off.
- `@colibri-social/telemetry` builds, buckets and sends the heartbeat.
- `VoiceSfu.stats()` reports calls, participants, transport stats and worker CPU. `WorkerPool.usage()` reads worker CPU time.
- `SpaceSyncEngine.queueStats` reports pending and running repo syncs.
