# NaviMower Zone Scheduler ([NaviMower](https://github.com/vahesoo/NaviMower) Add-on)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![Version](https://img.shields.io/github/v/release/klarah32/navimower-zone-scheduler?label=version)](https://github.com/klarah32/navimower-zone-scheduler/releases)

Current version: **1.3.19** (see [CHANGELOG.md](CHANGELOG.md) for release notes).
HACS reads this same version from `manifest.json`, so it also shows up next
to the repo in HACS's integration list and on this repo's GitHub Releases
page -- no separate place to keep in sync.

A standalone Home Assistant integration that adds, for every zone of a
[NaviMower](https://github.com/vahesoo/NaviMower)-managed mower, a
**"&lt;zone&gt; mow interval"** slider (`number` entity, 1–7 days) and a
**"&lt;zone&gt; mow enabled"** switch that controls whether the zone is
considered for scheduling at all, plus a matching dashboard card -- both
bundled in this one repo/integration.

It is deliberately **independent** of the `navimower` integration: it never
imports its Python code and is never touched by a NaviMower update. It only
reads the `zones` attribute off the mower's "Schedule" sensor and calls
NaviMower's own `navimower.set_schedule` / `navimower.mow` services -- the
same way any Home Assistant automation would.

A brand-new zone's interval defaults to **1 day**, and its enabled switch
defaults to **off**, and neither needs a manual setup step: as soon as
NaviMower reports a zone, both entities appear here automatically, ready to
be turned on and adjusted.

## The bundled card

`navimow-zone-interval-card` (bundled under
`custom_components/navimower_zone_scheduler/www/`) shows, per zone: a
checkbox to include/exclude it from scheduling, its name (greyed out while
excluded, highlighted green when the backend's `get_due_zones` says it's
overdue), how long ago it was last completed, and a slider for its
interval. It also has:

- **Preview next 7 days** -- calls `navimower_zone_scheduler.preview_due_schedule`
  to show which zones would be due each day, the exact same calculation
  `save_due_schedule` uses to decide what to write.
- **Save to mower** -- re-fetches that same preview, then calls
  `navimower_zone_scheduler.save_due_schedule` once, which writes only the
  days that actually have zones due, after an editable time-range and a
  confirmation step (since it overwrites a whole weekday's plan).
- **Mow due zones now** -- calls `navimower_zone_scheduler.get_due_zones`
  to name today's due zones in a confirmation dialog, then
  `navimower_zone_scheduler.mow_due_zones` to start mowing them.

The card has no client-side reimplementation of the due-zone calculation --
every button above, and the row highlighting, ask the backend for the
answer, so the card can never show or act on a different zone list than an
automation calling the same actions would.

**The integration registers the card for you** -- on setup it serves the
bundled JS as a static path and injects it on every dashboard
(`add_extra_js_url`), the same self-registering pattern `navimow_pro` uses
for its own cards. You do **not** need to add it under Settings →
Dashboards → Resources by hand.

## Installing via HACS

This repo is not in the default HACS store, so add it as a **custom
repository** first:

1. HACS → the **⋮** menu (top right) → **Custom repositories**.
2. Repository: `https://github.com/klarah32/navimower-zone-scheduler`
   Category: **Integration**
   → **Add**.
3. Search HACS for **"NaviMower Zone Scheduler"** → **Download**.
4. **Restart Home Assistant.** (This also registers the card -- see above.)
5. Settings → Devices & Services → **+ Add Integration** → search
   **"NaviMower Zone Scheduler"**.
6. Pick the target mower's Schedule sensor (e.g. `sensor.gerd_schedule`).
7. Repeat step 5–6 once per mower -- one config entry = one mower.
8. **Hard-refresh the browser tab** (Ctrl+Shift+R / Cmd+Shift+R, or clear
   the site cache) before opening the dashboard. The card JS is served
   from a fixed URL, so a browser that already cached an older copy won't
   pick up the new version on a normal reload.

## Installing manually (no HACS)

1. Download this repo (Code → Download ZIP, or `git clone`).
2. Copy the `custom_components/navimower_zone_scheduler/` folder (which
   includes its `www/` subfolder -- keep that) into your Home Assistant
   `config/custom_components/` folder, so you end up with
   `config/custom_components/navimower_zone_scheduler/manifest.json`.
3. **Restart Home Assistant.**
4. Same as HACS steps 5–7 above.
5. **Hard-refresh the browser tab** (Ctrl+Shift+R / Cmd+Shift+R, or clear
   the site cache) before opening the dashboard -- same reason as the HACS
   step above: the card JS URL doesn't change between versions, so a stale
   browser cache can otherwise keep serving the old card.

## Adding the card to a dashboard

Once the integration has been set up for at least one mower (step 6/7
above), the card is available like any built-in card:

- **UI:** Edit dashboard → Add card → search "Navimow Zone Mow Interval".
- **YAML:**
  ```yaml
  type: custom:navimow-zone-interval-card
  entity: sensor.gerd_schedule       # same Schedule sensor as the config entry
  title: "Gerd - mow interval per zone"
  device_id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # needed for Save/Mow-now
  start: "09:00"
  end: "20:00"
  ```
  `device_id` is the mower's HA device ID (Settings → Devices → open the
  mower → it's in the URL).

Add one card per mower, pointing each at that mower's own Schedule sensor.

## Services (Actions)

Three domain-level actions, available as soon as the integration is
installed. The config entry also creates a per-mower due-zone sensor, so
automations do not need to duplicate the due-zone calculation:

- **`navimower_zone_scheduler.get_due_zones`** -- response-only action that
  calculates today's due zones live, without starting the mower. The response
  contains `zone_ids`, `zone_names`, `count`, detailed `due_zones` data, and
  diagnostic counts (`schedule_zone_count`, `interval_zone_count`, and
  `completed_zone_count`). This is the recommended source for automations
  because it calculates the result at action time rather than relying on a
  cached sensor state.
- **`navimower_zone_scheduler.mow_due_zones`** -- calculates which zones
  are due *today* (own interval elapsed since last full completion) and
  calls `navimower.mow` with just those zones, immediately. Zones whose
  mow-enabled switch is off are never included.

  Both actions (and the sensor's `due_zones` attribute below) list/mow
  zones ordered by last-completion date, **oldest first** -- the zone
  that's gone longest without being mowed comes first, and a zone that's
  never been completed at all is treated as the most overdue of all. The
  dashboard card's own "Mow now" button uses the same ordering.
- **`navimower_zone_scheduler.save_due_schedule`** -- simulates which
  zones would be due on each of the next 1-7 days (starting *tomorrow*,
  not today -- use `mow_due_zones` for today) and calls
  `navimower.set_schedule` once per weekday that actually has a zone due,
  with your given `start`/`end` window. Days with nothing due are left
  completely untouched.

  A zone that's due today is only assumed handled (and skipped from
  tomorrow's projection) if it has *actually* been completed today --
  not just because `mow_due_zones` was supposed to run. If today's mow
  doesn't happen (skipped, failed, rained out, whatever), that zone
  automatically carries into tomorrow's saved schedule too, so it isn't
  silently missed for a full interval.

  `start`/`end` accept either a fixed `"HH:MM"` (must land on a 15-minute
  mark -- that's the only raster `navimower.set_schedule` accepts) or a
  sun-relative spec: `"sunrise"`, `"sunset"`, or an offset in minutes such
  as `"sunrise+30"` / `"sunset-45"`. Sun-relative specs are resolved
  separately for *each* day being saved -- using that day's actual
  sunrise/sunset, not the day the automation happens to run -- and the
  result is snapped to the nearest 15-minute mark.

Both take `schedule_entity` (the mower's Schedule sensor) and a **Mower**
device picker (backed by `device_id`, filtered to NaviMower devices only --
so there's no way to accidentally paste the wrong ID, e.g. an automation's
own ID instead of a device's). Wire either into a time-triggered
automation via the UI action editor, or in YAML:

```yaml
alias: Navimow - mow due zones now (Gerd)
trigger:
  - platform: time
    at: "07:00:00"
action:
  - action: navimower_zone_scheduler.mow_due_zones
    data:
      schedule_entity: sensor.gerd_schedule
      device_id: "PUT_MOWER_DEVICE_ID_HERE"  # pick via the UI form's device selector
      reset: false
```

```yaml
alias: Navimow - save next 7 days (Gerd)
trigger:
  - platform: time
    at: "06:00:00"
action:
  - action: navimower_zone_scheduler.save_due_schedule
    data:
      schedule_entity: sensor.gerd_schedule
      device_id: "PUT_MOWER_DEVICE_ID_HERE"  # pick via the UI form's device selector
      start: "sunrise-30"
      end: "sunset+30"
      days: 7
```


### Due-zone sensor

Each configured mower exposes a sensor named `<mower> Mow Due Zones`, for
example `sensor.eltern_mow_due_zones`. Its numeric state is the number of
zones due today. The `zone_names`, `zone_ids`, and `due_zones` attributes come
from the same canonical calculation used by `mow_due_zones` and
`get_due_zones`.

The sensor also exposes diagnostic attributes:

- `schedule_zone_count` -- number of zones currently reported by the Schedule
  sensor.
- `interval_zone_count` -- number of schedule zones with an active mow
  interval entity (regardless of that zone's enabled switch).
- `completed_zone_count` -- number of eligible zones for which a valid
  `*_last_completed*` completion timestamp was found.

The **independent per-zone `number.*_mow_interval` entities remain the source
of truth for interval configuration**. The due-zone sensor does not replace
those entities.

For automations, prefer the response from `get_due_zones` so the due list is
calculated live at the moment the automation runs. The sensor is intended for
dashboards, cards, templates, and status display.

Example notification automation (live response):

```yaml
alias: "Eltern: mow due zones now (redmi_note_4)"
sequence:
  - action: navimower_zone_scheduler.get_due_zones
    data:
      schedule_entity: sensor.eltern_schedule
    response_variable: due

  - variables:
      due_zone_names: "{{ due.zone_names | default([], true) }}"

  - if:
      - condition: template
        value_template: "{{ due_zone_names | length == 0 }}"
    then:
      - action: notify.mobile_app_redmi_note_4
        data:
          title: Eltern
          message: No zones are due to mow right now.
    else:
      - action: notify.mobile_app_redmi_note_4
        data:
          title: Eltern - mow due zones?
          message: "{{ due_zone_names | join(', ') }}"
          data:
            tag: eltern_mow_confirm
            actions:
              - action: ELTERN_MOW_CONFIRM
                title: Mow
              - action: ELTERN_MOW_DENY
                title: Cancel
      # wait_for_trigger / confirmation follows here; on confirmation call
      # navimower_zone_scheduler.mow_due_zones with the same schedule_entity.
```

This automation deliberately does not calculate intervals or completion
entities itself. The integration owns that logic in one place, and the
`get_due_zones` response calculates the list live when the automation runs.

## How due-zone matching works

The integration keeps the per-zone interval and enabled-switch entities
independent. For each configured mower, it first reads the zones from the
mower's Schedule sensor and the corresponding `number.*_mow_interval` and
`switch.*_mow_enabled` entities.

For completion history it finds the mower's `*_last_completed*` sensors and
matches them to schedule zones by scoping to the mower's *device* (via the
entity registry, not by parsing any entity's name) and matching only the
zone-name slug immediately preceding `_last_completed` in the entity ID --
e.g. `sensor.eltern_birnbaum_last_completed` matches zone "Birnbaum". This is
important because Home Assistant entity IDs can have collision suffixes such
as `_2` or `_3`, and because a schedule sensor's own entity ID can pick up
unrelated words (like an area name) that the completion sensors' IDs never
have -- device-scoping avoids relying on that at all. The first matching
sensor found is used.

A missing or invalid completion timestamp makes that zone due. A zone whose
`switch.*_mow_enabled` is off is not considered for mowing at all,
regardless of its interval.

If automatic matching still picks the wrong sensor for a zone (or none at
all -- for example if a mower has multiple completion sensors for the same
zone name and the "first found" one isn't the right one), each zone has a
`select.<mower>_<zone>_completion_source` entity (see below) -- set it once
and every consumer (services, sensor, card) uses the corrected sensor
everywhere. This is the only override point: there is no separate
per-card/dashboard override, so a fix here always applies everywhere this
zone's completion data is used.

Every "which zones are due" decision -- the card's row highlighting, its
"Mow due zones now" button, its 7-day preview, the `Mow Due Zones` sensor,
and the `get_due_zones`/`mow_due_zones`/`save_due_schedule` actions -- is
calculated by this same backend logic. The card has no client-side
reimplementation of it: it calls the actions above and displays their
response, so it can never show or act on a different due-zone list than
an automation calling those same actions would.

### Per-zone entities

Alongside the `number.*_mow_interval` and `switch.*_mow_enabled` entities,
each zone also gets:

- **`button.<mower>_<zone>_mark_completed_now`** -- manually marks the zone
  completed right now. Useful when Navimower's own completion sensor for
  that zone is stale, disabled, or hasn't synced yet, but you know the zone
  was just mowed. This can only set "now", never a past timestamp, and is
  automatically superseded once Navimower's own data catches up -- pressing
  it never permanently disconnects the zone from Navimower's reporting.
  The zone's `*_last_completed` sensor shows a `manual` attribute (`True`
  while a manual press is the newest value) so the card can flag it as
  manual rather than mower-reported.
- **`select.<mower>_<zone>_completion_source`** -- overrides which
  `*_last_completed*` entity feeds that zone, for the rare case the
  automatic device + zone-name match picks the wrong one (see above).
  Defaults to "Automatic".

## Automation recommendation

Use `navimower_zone_scheduler.get_due_zones` with a `response_variable` when
an automation needs the current due-zone list. Do not duplicate the interval
or `last_completed` calculation in YAML. Use `sensor.<mower>_mow_due_zones`
when you need a dashboard/status entity instead.

## After installing

Also enable NaviMower's own `sensor.<zone> last completed` entities
(Settings → Devices & Services → the mower → Entities → filter "Disabled")
-- they're off by default in NaviMower itself, and the card uses them to
show how overdue a zone is.

## Startup timing

This integration has no cloud calls of its own, so on a full Home
Assistant restart it can be ready before `navimower`'s own Schedule
sensor has its first update. As of 1.3.18 it waits briefly for that
sensor to have usable zone data before finishing setup, and retries
automatically (with backoff, visible under Settings -> Devices &
Services) if it's still not there. If you have your **own** automation
that calls `get_due_zones` / `mow_due_zones` / `save_due_schedule` on
Home Assistant startup, give it a short delay (or a `wait_for_trigger` on
the schedule entity) first -- the config entry retrying doesn't help a
service call made directly from your own automation.

## Updating

Via HACS: HACS will flag new releases like any other repo -- Update from
there, then restart (so the new card JS gets served). Manually: repeat the
"Installing manually" steps, overwriting the whole folder including `www/`,
then restart.

**After updating, hard-refresh the browser** (Ctrl+Shift+R / Cmd+Shift+R)
on any tab showing the dashboard, or the card can keep running the old
cached JS even though the backend and HACS both report the new version.

## Uninstalling

Settings → Devices & Services → the mower entry → **⋮** → Delete, once per
mower. This removes the entities and their stored interval/enabled values
but leaves NaviMower itself completely untouched. Then remove via HACS (or
delete the `custom_components/navimower_zone_scheduler/` folder manually)
and restart. Remove any dashboard cards separately -- deleting the
integration doesn't touch your dashboards.
