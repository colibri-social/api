# @colibri-social/voice

## 0.6.0

### Minor Changes

- 4bcbcf0: Adds voice permissions that admins can set per role and per channel. Every member keeps them by default.
  
  - `voice.speak`: members without it stay muted. Their screen share sound still plays.
  - `voice.listen`: members without it can't hear the call. Cameras and screen shares still show.
  - `voice.camera` and `voice.screenshare`: members without them can't turn on their camera or share their screen.
  - `voice.chat`: members without it can't read or post in the voice channel's text chat.
  
  When an admin changes these mid-call, the AppView applies them right away, stops any camera or screen share the member lost, and tells their client. A moderator unmute never lifts a mute that comes from a missing permission.
  
  The Members role of every Space gains the five permissions once at startup. Removing them later sticks. Spaces whose credentials are missing keep their current Members role until the owner signs in again.
  
  Lexicons:
  - `social.colibri.beta.voice.defs#joined` lists the member's voice permissions in `permissions`.
  - New `social.colibri.beta.voice.defs#permissionsChanged` frame with the updated list.
  - `social.colibri.beta.voice.defs#moved` carries the destination's `channelView` in `view`, and in `after` the nearest channel before it in its category that the member can read.
  - `serverMuted` and `serverDeafened` also cover a missing `voice.speak` or `voice.listen`.
  
  `@colibri-social/community` adds `voiceCapabilities` and `voicePermissionKeys`. `@colibri-social/voice` adds `VoiceSfu.setRestriction`, `restrictionOf` and `moderationOf`.

## 0.5.0

### Minor Changes

- ac153a2: Report metrics, traces and logs, and send an anonymous daily heartbeat.
  
  - The AppView serves Prometheus metrics on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`, `0` turns them off), labeled with the node and region: XRPC duration by method and status, client sockets, Jetstream lag and events, the space sync queue, lag and failures, push deliveries by provider and outcome, drain state, write mode and queued writes, calls and participants, SFU worker CPU, bitrate, packet loss and transports by ICE state, and TURN credential requests.
  - Sentry traces every request except `/health` and keeps those over 1 second, those that failed, and `SENTRY_TRACES_SAMPLE_RATE` (default 0.1) of the rest. Voice joins, transport setup, space repo syncs and push sends get their own spans. Logs at info and above go to Sentry Logs. Clustered nodes tag events with their ID, region and roles.
  - The main node sends an anonymous heartbeat once a day to `COLIBRI_TELEMETRY_URL` (default `https://telemetry.colibri.social/v1/heartbeat`), an hour after the first start logs a notice. Counts are rounded into ranges. `COLIBRI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turns it off.
  - `@colibri-social/telemetry` builds, buckets and sends the heartbeat.
  - `VoiceSfu.stats()` reports calls, participants, transport stats and worker CPU. `WorkerPool.usage()` reads worker CPU time.
  - `SpaceSyncEngine.queueStats` reports pending and running repo syncs.
- 43899d5: Run voice calls across AppView nodes.
  
  - Each SFU worker listens on one UDP and TCP port through a mediasoup `WebRtcServer`, starting at `SFU_RTC_PORT` (default 40000). `SFU_RTC_MIN_PORT` and `SFU_RTC_MAX_PORT` are removed. The compose file publishes 40000-40031.
  - The SFU reads its settings from the AppView config. `SFU_INITIAL_OUTGOING_BITRATE` is part of it now, and `voiceSfuConfigFromEnv` is removed from `@colibri-social/voice`.
  - A call runs on one node. `voice_calls` pins it there, and a join on another node answers with `callElsewhere`. A call on a node that stopped reporting moves to the next node someone joins on.
  - Who is in a call lives in the new `voice_participants` table, so presence shows voice state from every node and `voice.moderate` reaches a call on any node over the event bus. The main node clears participants of nodes that stopped reporting and announces that they left.
  - Server mutes and deafens are stored per Space member in the new `voice_moderation` table. They apply in every voice channel of the Space and last across calls, restarts and nodes until a moderator lifts them.
  - A call that grows past `SFU_PARTICIPANTS_PER_WORKER` (default 20) participants per worker takes another worker, up to `SFU_WORKER_COUNT`. Its routers pipe every producer to each other, so everyone still hears everyone. New calls start on the worker with the fewest routers.
  - With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, every transport gets Cloudflare TURN credentials valid for 24 hours, next to `SFU_ICE_SERVERS`.
  - When a voice node drains, every call gets a `migrationProposal` with the other voice nodes. Participants answer with `rttReport`, and after `VOICE_MIGRATION_NOTICE_SECONDS` (default 60) or a `moveNow` the call moves with `migrateTo` to the node with the lowest worst-case round trip. A node that shuts down tells remaining callers `nodeClosed`. `joined` carries the node ID and region.
  - `Database` exposes `primary` for reads that can't wait for a replica.

## 0.4.0

### Minor Changes

- 9d42e5c: Add the `setConsumerPreference` voice frame. A viewer sets the highest simulcast or SVC layer it wants for one of its consumers and can pause it while its tile is off screen. A viewer pause survives `resumeConsumer` and undeafen, and deafen still keeps audio paused. Screen share video gets twice the priority of cameras when bandwidth is short, and send transports cap incoming media at 20 Mbps.

### Patch Changes

- 9d42e5c: Keep screen share sound playing when the person sharing mutes their own microphone. A self-mute now pauses only the microphone producer. A server mute still pauses every audio producer, whatever source it claims.

## 0.3.0

### Minor Changes

- 7480051: Add the `setSpeaking` voice frame. A client that sends it decides its own speaking state, and the server stops using the audio level for that member. Clients that never send it keep the level-based state. Muting, by the member or a moderator, always clears the speaking state. Every speaking change now also goes out as a `voiceEvent` with `event: "speaking"` on the community's live feed.
- a6eb9be: Add the `codecUnsupported` voice frame. When a viewer can't decode the video codec of a screen share, the SFU answers the viewer's `consume` with a `NotFound` error and sends `codecUnsupported` with the `producerId` to the sharer's session, at most once per producer. The sharer can then produce the screen share again with a more widely supported codec. Microphone and camera consumption are unchanged.

### Patch Changes

- e2936c1: Start new viewers at 3.5 Mbps and space screen share keyframe requests 400 ms apart, so a screen share reaches full quality sooner after it starts or a viewer joins.

## 0.2.1

### Patch Changes

- 4ab879d: Offer VP9 and 1080p-capable H264 next to VP8, start new viewers at 1.5 Mbps, ask for a keyframe when a video stream resumes, space keyframe requests for screen shares, and keep video playing for deafened listeners

## 0.2.0

### Minor Changes

- bf32399: Adds optional `camera` and `screen` flags to `social.colibri.beta.actor.defs#voiceState`. The AppView sets them from each participant's video producers and sends a voice `update` event to the community when a camera or screen share starts or stops, so clients can show who is sharing in channels they haven't joined.

## 0.1.3

### Patch Changes

- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer

## 0.1.2

### Patch Changes

- 1669210: Wait for every mediasoup worker subprocess to exit before the appview process does, so a restart no longer fails on ports the old workers still hold
- 16a342d: Announce a voice join as soon as the peer joins, not when it creates its first transport
- f67763b: Ask Opus for DTX alongside inband FEC, and cap the initial outgoing bitrate estimate

## 0.1.1

### Patch Changes

- dc9ea5c: Default the SFU's RTC port range to 40000-40100, the range the compose file publishes. With neither `SFU_RTC_MIN_PORT` nor `SFU_RTC_MAX_PORT` set, transports took a port from mediasoup's own 10000-59999 default, so almost every candidate pointed at a port nothing forwarded and calls failed to connect.
- 07d1508: Give each account a single voice session. Joining a voice channel now retires that account's other voice sockets with a `superseded` reason, so a second device takes the call over instead of running alongside it, and nobody can sit in two channels at once. A handover within the same channel keeps the participant record, so the rest of the room sees the media move rather than a leave followed by a rejoin.
  
  Along with it, a set of voice fixes:
  
  - A frame the SFU cannot serve is answered with an error instead of rejecting unhandled, which could take the process down when Sentry was not configured.
  - A server mute now pauses every audio producer rather than only the one declaring `mic`, survives the muted account reconnecting, and can be applied before that account carries any media.
  - Voice connections release their topic subscriptions when they close, and frames from one socket are handled in order, so a socket can no longer leave a channel claiming it forever.
  - A transport mediasoup reports as closed or failed is closed rather than only forgotten, releasing its ports and its producers instead of replaying dead producers to everyone who joins.
  - The speaking indicator settles after the debounce window even when no further audio arrives, and clears when a speaker leaves mid-word.
  - A room whose worker died is torn down, so presence stops reporting its participants as being in a call.
  - `produce`, `consume` and `setSelfState` no longer conjure a participant from a frame naming an unknown transport, which used to announce a phantom join to the whole community.
  - Joining replays who is already in the room and what moderation applies to them, and producer frames carry `paused`.
  - Presence is claimed before the room is created, so two devices racing to create transports cannot leave one of them live in an untracked room.
  - `SFU_ICE_SERVERS` reaches clients through `transportOptions`, so configured STUN and TURN servers are used instead of silently dropped.

## 0.1.0

### Minor Changes

- efcadc8: Separate a peer's own mute from a moderator's
