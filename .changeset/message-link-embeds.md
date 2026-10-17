---
"@colibri-social/appview": minor
---

Fills `embeds` on message views with link previews for up to five links per message, skipping links the author suppressed. Reads wait up to 2 seconds for previews that aren't cached yet. Live message events go out right away and are followed by an `update` event once a pending preview resolves. Direct image and video links become image or video embeds without fetching a page. Previews stay cached for 6 hours, and failed links are retried after 5 minutes.
