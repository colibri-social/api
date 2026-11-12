---
"@colibri-social/bridge-core": patch
"@colibri-social/bridge-discord": patch
---

Bridge timestamps in both directions. A `<t:...>` timestamp from a bridged platform arrives as a `#time` facet with the matching style, and a `#time` facet goes out as a native timestamp. Time references use the `bridge:time/<seconds>:<style>` form.
