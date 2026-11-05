---
"@colibri-social/lexicons": minor
"@colibri-social/space": minor
"@colibri-social/space-sync": minor
"@colibri-social/projections": minor
"@colibri-social/community": minor
"@colibri-social/appview": minor
---

Address reactions and replies by full record URI. `social.colibri.beta.reaction` gains an optional `uri` and `social.colibri.beta.message` an optional `parentUri`, next to the existing `target` and `parent` references. The projections read the URI first and fall back to the reference when the URI is missing, unparseable, in another space, or in another collection. `bridge.addReaction` takes an optional `uri`, and `bridge.postMessage` and `bridge.importMessages` take an optional `parentUri`. Records the community writes for a bridge carry both forms.

`reactionEvent` gains `uri` for the target message and `reaction` for the reaction record itself, and its `target` now follows the URI when the record has one. Deleting a reaction record now publishes a `reactionEvent` with `event: "delete"`. A `messageEvent` delete carries `subjectUri`. `RecordDelete` in `@colibri-social/space-sync` carries the removed record's `previous` value when the store held it. `@colibri-social/space` adds `sameSpaceRecordPointer`, `tryParseSpaceRecordUri` and `trySpaceRecordUri`.
