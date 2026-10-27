# @colibri-social/embeds

## 0.2.1

### Patch Changes

- 4ab879d: Fix channel reordering after a channel was deleted, and repair every category's channel order on startup and on each reorder. A new channel now takes its category's visibility rules as soon as it syncs. Messages edited outside Colibri now show as edited, a second reaction record with the same emoji no longer leaves a stale reaction behind, and links that point straight at an image, SVG included, now preview as that image.

## 0.2.0

### Minor Changes

- 8eba18b: Link previews carry more of what a page declares. `linkEmbed` gains `themeColor`, `layout`, `provider`, `author`, `publishedAt`, a `media` gallery and a `post` with formatted text, a content warning, engagement counts, a quoted post and the source language of a translation. The AppView reads `theme-color`, `twitter:card`, repeated `og:image` tags, the site icon and `article:published_time`, follows oEmbed links, resolves Mastodon statuses behind ActivityPub alternate links, and resolves X and fixer-domain post links through the FxEmbed API, honoring a trailing language code as a translation request.

## 0.1.0

### Minor Changes

- 384edf8: Link previews for YouTube come from YouTube's oEmbed endpoint. Watch, `youtu.be`, Shorts, live, embed, mobile and YouTube Music links resolve to one canonical watch URL that keeps a `t` timestamp. The preview shows the video title, the channel name as its description, "YouTube" as the site name, and the largest available thumbnail with its real dimensions, vertical for Shorts where YouTube has one. When oEmbed refuses a video, the preview falls back to the watch page with a consent cookie and `hl=en`, and a consent page fails the preview. Every outbound embed fetch sends `accept-language: en-US,en;q=0.9`, and page fetches send an HTML `accept` header. Failed unfurls are logged with a code.

## 0.0.1

### Patch Changes

- 145f753: Show the wide link card for sites that ship an OpenGraph image without `og:image:width` and `og:image:height`
- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer
- 4fe3ad3: Fixes a crash within the fetch handler
