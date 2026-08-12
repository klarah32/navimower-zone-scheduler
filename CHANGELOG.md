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
