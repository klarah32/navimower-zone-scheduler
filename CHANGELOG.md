## 1.3.17
- Fixed the actual root cause of unreliable "last completed" discovery:
  both the backend (`service.py`) and the card were deriving a mower
  "prefix" by string-slicing the *schedule* entity's own entity ID
  (`sensor.garten_eltern_schedule` -> `garten_eltern_`). When that slug
  picks up an unrelated word -- like "garten" from an area/category --
  the completion sensors' own entity IDs never had that word
  (`sensor.eltern_birnbaum_last_completed`, no "garten"), so the prefix
  never matched anything and discovery silently found nothing.
- Discovery is now scoped by the schedule sensor's *device* (via the
  entity registry) instead of any derived prefix, and matches only on the
  zone-name slug immediately preceding `_last_completed` in the entity
  ID (plus an optional `_2`/`_3` collision suffix) -- nothing else. No
  `zone_name` attribute check, no `original_name` comparison. The first
  matching entity (sorted alphabetically) is used, full stop -- no
  timestamp-based "best match" ranking.
- This intentionally drops the `zone_name`-attribute matching added in
  1.3.16 in favor of this simpler, device-scoped, first-found approach.
- Bundled card version bumped to v1.3.17.

## 1.3.16
- More stable "last completed" sensor discovery: entity IDs such as
  `sensor.garten_eltern_birnbaum_last_completed` now also match by the
  zone-name slug embedded in the entity ID itself, not only by the
  sensor's `zone_name` attribute / entity-registry `original_name`.
  Covers cases where the attribute is missing/stale or a zone was renamed
  after the completion sensor was first created -- both backend
  (`service.py`, used by `mow_due_zones`/`save_due_schedule`/the due-zone
  sensor) and the card's own JS discovery are updated.
- `_norm_name` now strips diacritics (matching `_slugify_zone_name`), so
  an umlaut/accent in a zone name can no longer make the attribute match
  and the ID-slug match disagree.
- Card + visual editor: new "Advanced entity overrides" section (a
  collapsed-by-default panel) in the dashboard card's visual editor,
  listing every zone on the configured Schedule sensor with an entity
  picker to pin a specific "last completed" sensor for that zone,
  overriding automatic discovery when it's ambiguous or unreliable. Each
  field's helper text shows what the card currently auto-detects for that
  zone, so it's easy to see whether an override is actually needed.
  Stored as `entity_overrides: {<zone name, lowercased>: entity_id}` in
  the card config. Only affects this card's display/Mow-now/preview --
  not the backend services or the due-zone sensor, which keep using their
  own auto-discovery.
- Bundled card version bumped to v1.3.16.

## 1.3.15
- Fix card bug: `navimow-zone-interval-card` referenced `this._scheduleEntity`, which was never assigned anywhere -- always `undefined`. This silently disabled the strong `source_entity` + `zone_name` match in `_findInterval`, so the card fell back to matching by zone name alone across *all* mowers' interval entities. Two mowers sharing a zone name (e.g. both have "Birnbaum") could end up sharing the same underlying `number.*_mow_interval` entity: dragging the slider on one card's zone also changed the other mower's same-named zone.
- Now correctly scopes the match to `this._config.entity` (the schedule sensor this specific card is configured against), same as `_findLastCompleted` already did.
- Bundled card version bumped to v1.3.15.

## 1.3.14
- Prefix each `number.*_mow_interval` entity's name with its mower (derived from the config entry's schedule sensor, e.g. `sensor.eltern_schedule` -> "Eltern"), so two mowers sharing a zone name (e.g. both have "Birnbaum") get distinct entity IDs like `number.eltern_birnbaum_mow_interval` / `number.gerd_birnbaum_mow_interval` instead of colliding on `number.birnbaum_mow_interval` (+ `_2` suffix).
- No change to `unique_id`, storage keys, or the `source_entity`/`zone_name`/`zone_id` attributes the backend service and card already match on -- only the displayed/auto-generated name changes.

## 1.3.13
- Make `get_due_zones` the canonical live calculation for automation responses.
- Keep `sensor.*_mow_due_zones` as a presentation/cache of that same calculation.
- Add schedule/interval/completion diagnostic counts to the due-zone response and sensor.
- Preserve independent per-zone `number.*_mow_interval` entities.
- Completion lookup remains based on mower prefix + `zone_name`, including `_2`/`_3` entity-ID suffixes.

## 1.3.12
- Fix due-zone sensor setup by using `async_track_state_change_event`, the supported Home Assistant entity-state listener.
- Restores setup of the independent per-zone mow-interval number entities alongside the due-zone sensor.
- Bundled card version is now v1.3.12.

## 1.3.11
- Fix due-zone sensor publishing: explicitly writes updated state/attributes.
- Refresh due-zone sensor immediately when schedule, interval, or last-completed entities change.

## 1.3.10
- Fix mow-interval discovery by matching `source_entity` + `zone_name` first, then `zone_name`, then `zone_id`.
- Makes interval lookup robust to Home Assistant entity-ID renames/collision suffixes and keeps the card/backend aligned.

## 1.3.9
- Add a per-mower `Mow due zones` sensor exposing the canonical due-zone list and metadata.
- Add `navimower_zone_scheduler.get_due_zones`, a response-only service using the same calculation without mowing.
- Keep `mow_due_zones` and `save_due_schedule` on the same shared calculation path.
- The due-zone sensor refreshes on schedule changes and every minute.
- Bump the bundled card version to v1.3.9.

## 1.3.8
- Find all `*_last_completed*` sensors belonging to the configured mower first.
- Link completion sensors to schedule zones by the sensor `zone_name`, not by numeric zone ID.
- Accept Home Assistant collision suffixes such as `_2`, `_3`, etc.
- Apply the same mower-prefix + zone-name logic to live states and Recorder history.

## 1.3.7
- Fix completion lookup for Navimower's stable `zone_<zone_id>_last_completed` entity IDs, including Recorder-only history.
- This specifically fixes zones such as Mülltonnen when the completion entity is no longer present in `hass.states` or the entity registry.

# Changelog

## 1.3.6
- Fix Recorder-only `*_last_completed` lookup for zones whose completion entity was removed from the current entity registry.
- Add deterministic zone-name entity-ID candidates so historical completions such as Mülltonnen can still be found.
- Keep zone-id and exact zone-name matching as the preferred live-state paths.

## 1.3.5

- Fix zone completion lookup when current schedule zone IDs differ from historical completion sensor IDs.
- Fall back to zone-name matching and Recorder history for completion data that is no longer exposed as a live entity.
- Make repository metadata HACS-ready for `klarah32/navimower-zone-scheduler`.
- Show the card version as `v1.3.5`.
