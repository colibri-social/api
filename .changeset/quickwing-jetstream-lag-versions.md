---
"@colibri-social/appview": patch
---

Fix `colibri_jetstream_lag_seconds`, which read Jetstream v2's sequence cursor as a timestamp and reported about 57 years. It now measures the time since the last event by the event's own `time`, or by when it arrived. Each node also reports `colibri_build_info` labelled with its AppView version, and the cluster dashboard shows a Versions table per node.
