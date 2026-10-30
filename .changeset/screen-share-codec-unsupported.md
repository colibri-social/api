---
"@colibri-social/lexicons": minor
"@colibri-social/voice": minor
"@colibri-social/appview": minor
---

Add the `codecUnsupported` voice frame. When a viewer can't decode the video codec of a screen share, the SFU answers the viewer's `consume` with a `NotFound` error and sends `codecUnsupported` with the `producerId` to the sharer's session, at most once per producer. The sharer can then produce the screen share again with a more widely supported codec. Microphone and camera consumption are unchanged.
