---
"@colibri-social/lexicons": minor
"@colibri-social/voice": minor
"@colibri-social/appview": minor
---

Add the `setConsumerPreference` voice frame. A viewer sets the highest simulcast or SVC layer it wants for one of its consumers and can pause it while its tile is off screen. A viewer pause survives `resumeConsumer` and undeafen, and deafen still keeps audio paused. Screen share video gets twice the priority of cameras when bandwidth is short, and send transports cap incoming media at 20 Mbps.
