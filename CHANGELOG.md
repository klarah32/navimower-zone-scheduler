## 1.3.19-beta4
- Fixed a cross-mower entity-matching bug affecting `service.py`'s
  `_interval_entity()`, `_enabled_entity()`, and `_completed_entity()`
  (used by `mow_due_zones`/`save_due_schedule`/`get_due_zones`). Each
  correctly matched by `source_entity == schedule_entity` first, but its
  fallback path (for entities without a `source_entity` attribute yet,
  e.g. right after an upgrade) matched by `zone_name` or `zone_id` alone
  across *every* mower's entities, with no scoping at all. Two mowers
  sharing a zone name (e.g. both have a "Birnbaum" zone) -- or even just
  the same small numeric zone `id` -- could have the fallback silently
  attach to the *other* mower's interval/enabled/completion entity.
  All three fallbacks are now pre-scoped to `source_entity ==
  schedule_entity` before ever considering a name/id match, so a
  same-named or same-numbered zone on a different mower can no longer be
  selected.
- Applied the identical fix to the card's own JS-side lookups
  (`_findCompletedRaw`, `_findMarkCompletedButton`, `_findInterval`,
  `_findEnabledRaw` in `navimow-zone-interval-card-impl.js`), which had
  the same unscoped fallback pattern.
- Removed the card's dashboard-only **"Advanced entity overrides"**
  editor panel and its `entity_overrides` config key entirely. It only
  ever bypassed one card's own completion-sensor lookup and could
  silently disagree with what the backend services/other dashboards used
  for the same zone. The per-zone `select.<mower>_<zone>_completion_source`
  entity (added in 1.3.19-beta3) is the one remaining way to correct an
  automatically-matched completion sensor, and that fix now reaches every
  card and the backend services alike -- there's no separate per-card
  override left to fall out of sync with it.
- **The card no longer computes "which zones are due" itself.** Previously
  the row highlight, the "Mow due zones now" button, and the 7-day preview
  each used their own client-side reimplementation of the due-zone
  calculation (and "Mow now"/"Save to mower" called `navimower.mow` /
  `navimower.set_schedule` directly with that JS-computed zone list) --
  three separate implementations of the same logic, alongside the
  backend's `_eligible_zones`/`_due_zone_details`/`_simulate_due_schedule`
  in `service.py`, that could in principle disagree with each other or
  with an automation calling the backend services. The card is now a thin
  client over the backend:
  - Row "overdue" highlighting is sourced from the cached response of a
    throttled `navimower_zone_scheduler.get_due_zones` call, refreshed
    immediately after any toggle/slider/mark-completed/mow/save action.
  - The 7-day preview calls `navimower_zone_scheduler.preview_due_schedule`.
  - **"Mow due zones now"** calls `get_due_zones` (to name the zones in
    the confirmation dialog) then `navimower_zone_scheduler.mow_due_zones`
    -- no more direct `navimower.mow` call from the card.
  - **"Save to mower"** re-fetches `preview_due_schedule` for the
    confirmation dialog, then calls `navimower_zone_scheduler.
    save_due_schedule` once -- no more per-weekday `navimower.set_schedule`
    loop from the card.
  - There is now exactly one implementation of "which zones are due" (the
    backend's), so the card, the due-zone sensor, and any automation
    calling these services can no longer show or act on different zone
    lists.
  - Per-zone interval/enabled/last-completed *display* on each row is
    unaffected -- those are still read directly from their own entities,
    since they're this card editing a zone's own settings, not a due-zone
    decision.

## 1.3.19-beta3
- New per-zone **"mark completed now" button** (`button.<mower>_<zone>_mark_completed_now`,
  from `button.py`). Manually pins that zone's persisted completion
  "floor" to the current time -- for the rare case Navimower's own
  completion sensor is stale, disabled, or hasn't synced yet, and you
  know the zone was actually just mowed. The floor only ever moves
  forward: a manual press is superseded automatically once live/historical
  data from Navimower catches up to (or passes) it, and the paired
  `*_last_completed` sensor's `manual` attribute reads `True` in the
  meantime so the card can show a "(manual)" hint instead of presenting it
  as if it came from the mower. There's no way to set an arbitrary past
  timestamp -- only "now" -- which is what keeps this safe to combine with
  the floor's "never go backwards" rule without a separate bypass path.
- New per-zone **"completion source" select**
  (`select.<mower>_<zone>_completion_source`, from `select.py`). The
  automatic device + zone-name-slug match that picks each zone's
  `*_last_completed*` sensor (used by `mow_due_zones`, `get_due_zones`,
  `save_due_schedule`, and the card) is right the overwhelming majority of
  the time, but two zones whose names collide after slugifying -- possible
  after a rename in the Navimower app -- can point at each other's sensor.
  This select corrects that per zone, once, as a regular HA entity instead
  of the card's dashboard-only "Advanced entity overrides" section, so the
  fix follows the zone everywhere it's used (services, sensor, any
  dashboard) rather than only the one card/dashboard it was set on.
  Defaults to "Automatic" for every zone; only needs touching for a zone
  that's actually colliding.
- Split `navimow-zone-interval-card.js` into a tiny registration shim
  (this file) and the real implementation
  (`navimow-zone-interval-card-impl.js`, loaded lazily). Fixes the
  intermittent native Home Assistant "Configuration error" card some
  people saw on the Android companion app, which persisted even after
  clearing the frontend cache and WebView data.
  - Root cause: the card is injected via `add_extra_js_url()`, which
    does one dynamic `import()` of the script at frontend boot, racing
    against Lovelace trying to build the dashboard's cards. If Lovelace
    won that race -- more likely on a slow/flaky connection or a
    backgrounded Android WebView -- it decided the custom element didn't
    exist and permanently swapped in its own error card, with no retry
    once the real definition arrived and no relation to anything
    actually cached.
  - Fix: the file that has to win that race is now a small,
    dependency-free shim that defines the custom element synchronously
    the instant it runs -- easy to fetch and execute fast even on a poor
    connection. It lazily loads the ~1300-line real implementation via
    dynamic `import()` with automatic retries (a few attempts with
    increasing delays, shared across every card instance on a dashboard)
    instead of the previous single unguarded attempt, showing a small
    "loading..." placeholder in the meantime. A load that still fails
    after every retry shows a friendly, self-retrying inline message
    inside the (already-registered) card element itself -- never
    Lovelace's own unrecoverable error card again.
  - Also guarded both `customElements.define()` calls (the shim and the
    editor) with a `customElements.get()` check first, so a module
    executing twice in one session (e.g. a version bump landing
    mid-session) is a harmless no-op instead of an uncaught error.
  - The dashboard's "Add Card" picker entry (`window.customCards`) now
    registers from the shim instead of the impl module, so it appears
    immediately rather than waiting on the heavier module to load.
- `get_due_zones`, `mow_due_zones`, and the card's own standalone "Mow
  now" button now agree on due-zone order. Previously each due-zone list
  was in Schedule-entity zone order, and "Mow now" (which never calls
  `mow_due_zones` -- it computes its own due list in JS and calls
  `navimower.mow` directly) had drifted into a genuinely separate
  algorithm from the backend's. Both now sort by last-completion date,
  oldest first, so the most overdue zone is mowed/listed first; a zone
  that's never been completed sorts as the most overdue of all.
  - Backend: `_due_zone_details()` in `service.py` sorts `due_ids` once,
    so `get_due_zones`, `mow_due_zones`, and `save_due_schedule` all
    inherit the same order from a single place.
  - Card: `_computeDueToday()` in `navimow-zone-interval-card-impl.js`
    applies the identical sort to `dueToday`, so the "Mow now" button's
    confirmation dialog and mow order now match what `get_due_zones`
    reports for the same schedule.

## 1.3.19-beta2
- Fixed slow/stuck loading of `navimow-zone-interval-card`, especially
  noticeable on phones. On mount, the card was fetching a full five-year
  Recorder history (with attributes) for every zone's "last completed"
  sensor, even for sensors that already had a perfectly good live state --
  and, with more than one mower card on a dashboard, each card repeated
  its own full `config/entity_registry/list` fetch in parallel. The
  history fetch now only runs for entities that actually lack a live
  state and drops attributes from the payload (`no_attributes: true`);
  the entity-registry fetch is now shared and cached (15s) across all
  card instances on a dashboard instead of being re-fetched per card.

## 1.3.19
- Deselecting a zone's checkbox in `navimow-zone-interval-card` now greys
  out its entire row and disables its interval slider, instead of just
  italicizing the zone name -- the interval is meaningless while a zone
  isn't being scheduled, so the whole row (name, age, slider, value) is
  dimmed together and the slider can't be dragged until the zone is
  re-enabled.
- **Breaking change to zone participation:** a zone's mow-interval number
  (`number.*_mow_interval`) no longer doubles as its on/off switch.
  Setting it to `0` used to mean "not considered for scheduling" -- it now
  only ranges **1-7 days**, and every zone gets a new, separate
  `switch.*_mow_enabled` entity that controls whether the zone is
  considered at all. `mow_due_zones`, `save_due_schedule`,
  `get_due_zones`, and the `Mow Due Zones` sensor all now gate on this
  switch instead of on `interval == 0`.
  - **Migration:** on first load after updating, each zone's new switch
    seeds itself from whether that zone's *old* interval was already `> 0`
    -- so a zone you had actively scheduled keeps mowing on its existing
    schedule without any manual step. A zone that had `0` (or no interval
    entity at all) starts with its switch off, matching its old
    behavior. Any interval value already at `0` is bumped up to the new
    minimum of `1` once loaded, but stays off via its switch until you
    turn it on.
  - Brand-new zones added after this update default to interval `1` and
    switch **off**, same net effect as the old "starts at 0" default.
- The bundled `navimow-zone-interval-card` gained a checkbox in front of
  each zone's name, wired to its new enabled switch, replacing the old
  "drag the slider to 0" way of excluding a zone. A disabled zone's name
  is still greyed out/italic, now driven by the switch instead of the
  interval value. Toggling the checkbox updates the row and the 7-day
  preview (if open) immediately, via the same local-override bridge the
  interval slider already used for instant feedback.
- The card's 7-day preview now labels each row with just the weekday name
  (e.g. "Wednesday") instead of a short weekday + calendar date -- the
  preview always covers exactly the next 7 days, so no two rows can land
  on the same weekday and the date added nothing the weekday didn't
  already convey.

## 1.3.18
- Fixed a race condition in the card's static-path registration
  (`_async_register_card`): with multiple mowers (multiple config
  entries), Home Assistant sets those entries up concurrently, and two
  entries could both see the card as "not yet registered" before either
  finished awaiting registration -- so both raced to register the same
  static path. The loser logged "Added route will never be executed,
  method GET is already registered" and bailed out without registering
  anything, leaving `navimow-zone-interval-card.js` genuinely unserved
  (404s in the browser) for every entry after the first, even though the
  card "worked" on whichever mower happened to win the race. Registration
  is now serialized with an `asyncio.Lock`, with a re-check after the
  lock is acquired in case another entry finished while waiting.
- The card now reads and displays its own version from the integration's
  `manifest.json` -- via a `?v=<version>` query string on its registered
  script URL, parsed inside the card with `import.meta.url` -- instead of
  a hardcoded `CARD_VERSION` constant in the JS file. The old constant
  had already drifted out of sync with the manifest (still read
  `"1.3.17"` as of 1.3.18-beta2); this makes that impossible going
  forward, and doubles as a cache-buster on every version bump.
- Fixed a startup race: on a full Home Assistant restart, this integration
  (no cloud I/O of its own) routinely finished setting up before
  `navimower`'s own cloud-backed Schedule sensor had its first update,
  which meant zone entities briefly (and sometimes not-so-briefly) didn't
  exist, and any boot-time automation calling `get_due_zones` /
  `mow_due_zones` / `save_due_schedule` could fail with "Schedule entity
  not found".
- Added `after_dependencies: [navimower]` to `manifest.json` so Home
  Assistant prefers setting up `navimower` first when both are present.
- `async_setup_entry` now polls briefly (up to ~10s) for the configured
  Schedule sensor to report a usable `zones` attribute before continuing.
  If it's still not there, the config entry raises `ConfigEntryNotReady`
  so Home Assistant retries the entry on its own backoff schedule (visible
  under Settings -> Devices & Services as "not ready, retrying") instead
  of finishing "successfully" with zero zone entities.
- The `Mow Due Zones` sensor no longer raises out of its periodic/event
  update when the schedule entity is briefly unavailable (e.g. navimower
  reloading later); it now just skips that update and retries on the next
  event or the 1-minute interval.
- Clarified the `HomeAssistantError` messages from `get_due_zones` /
  `mow_due_zones` / `save_due_schedule` to call out the startup-race case
  explicitly, for anyone still hitting it from their own automations.
- Fixed `hassfest` CI failures: added `recorder` to `after_dependencies`
  (it's used opportunistically for history lookups, wasn't declared
  anywhere) and added `CONFIG_SCHEMA = cv.config_entry_only_config_schema`
  since this integration is config-flow-only.
- Added a `LICENSE` file (MIT) to fix the `hacs` validation license check.

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
