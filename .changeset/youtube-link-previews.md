---
"@colibri-social/embeds": minor
"@colibri-social/appview": patch
---

Link previews for YouTube come from YouTube's oEmbed endpoint. Watch, `youtu.be`, Shorts, live, embed, mobile and YouTube Music links resolve to one canonical watch URL that keeps a `t` timestamp. The preview shows the video title, the channel name as its description, "YouTube" as the site name, and the largest available thumbnail with its real dimensions, vertical for Shorts where YouTube has one. When oEmbed refuses a video, the preview falls back to the watch page with a consent cookie and `hl=en`, and a consent page fails the preview. Every outbound embed fetch sends `accept-language: en-US,en;q=0.9`, and page fetches send an HTML `accept` header. Failed unfurls are logged with a code.
