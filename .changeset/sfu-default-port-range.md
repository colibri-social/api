---
"@colibri-social/voice": patch
"@colibri-social/appview": patch
---

Default the SFU's RTC port range to 40000-40100, the range the compose file publishes. With neither `SFU_RTC_MIN_PORT` nor `SFU_RTC_MAX_PORT` set, transports took a port from mediasoup's own 10000-59999 default, so almost every candidate pointed at a port nothing forwarded and calls failed to connect.
