# @colibri-social/embeds

## 0.0.1

### Patch Changes

- 145f753: Show the wide link card for sites that ship an OpenGraph image without `og:image:width` and `og:image:height`
- b03c206: Exit on a fatal error so the container restarts clean, guard the async paths that could reach one, and cap the repo CAR buffer
- 4fe3ad3: Fixes a crash within the fetch handler
