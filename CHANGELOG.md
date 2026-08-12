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
