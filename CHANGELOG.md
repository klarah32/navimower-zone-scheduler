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
