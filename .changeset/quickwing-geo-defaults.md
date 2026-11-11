---
"@colibri-social/appview": patch
---

Steer callers to new regions without `CLOUDFLARE_GEO_REGIONS`. Common region IDs such as `eu`, `us-east`, `us-central`, `us-west`, `asia` and `au` map to Cloudflare regions on their own, and each Cloudflare region gets its pools closest first. `CLOUDFLARE_GEO_REGIONS` now overrides single regions, and a region without a mapping logs `cloudflare.regionUnmapped`.
