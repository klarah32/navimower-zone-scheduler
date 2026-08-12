# NaviMower Zone Scheduler

A standalone Home Assistant integration that adds a **"&lt;zone&gt; mow
interval"** slider (`number` entity, 0–7 days) for every zone of a
[NaviMower](https://github.com/vahesoo/NaviMower)-managed mower, plus a
matching dashboard card -- both bundled in this one repo/integration.

It is deliberately **independent** of the `navimower` integration: it never
imports its Python code and is never touched by a NaviMower update. It only
reads the `zones` attribute off the mower's "Schedule" sensor and calls
NaviMower's own `navimower.set_schedule` / `navimower.mow` services -- the
same way any Home Assistant automation would.

A zone's interval defaults to **0 = "not considered"** and needs no manual
setup step: as soon as NaviMower reports a zone, its slider appears here
automatically, at 0, ready to be raised.

## The bundled card

`navimow-zone-interval-card` (bundled under
`custom_components/navimower_zone_scheduler/www/`) shows, per zone: name
(greyed out at interval 0, highlighted green when overdue), how long ago it
was last completed, and a slider for its interval. It also has:

- **Preview next 6 days** -- simulates which zones would be due each day,
  respecting each zone's own interval.
- **Save to mower** -- writes only the days that actually have zones due,
  via `navimower.set_schedule`, with an editable time-range and a
  confirmation step first (since that service overwrites a whole weekday's
  plan).
- **Mow due zones now** -- starts mowing today's due zones immediately via
  `navimower.mow`, without touching the recurring schedule.

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

## Installing manually (no HACS)

1. Download this repo (Code → Download ZIP, or `git clone`).
2. Copy the `custom_components/navimower_zone_scheduler/` folder (which
   includes its `www/` subfolder -- keep that) into your Home Assistant
   `config/custom_components/` folder, so you end up with
   `config/custom_components/navimower_zone_scheduler/manifest.json`.
3. **Restart Home Assistant.**
4. Same as HACS steps 5–7 above.

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
  calls `navimower.mow` with just those zones, immediately. Zones with
  interval 0 are never included.
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
  interval (`> 0`).
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

The integration keeps the per-zone interval entities independent. For each
configured mower, it first reads the zones from the mower's Schedule sensor
and the corresponding `number.*_mow_interval` entities.

For completion history it finds the mower's `*_last_completed*` sensors and
matches them to schedule zones by the sensor's `zone_name`. This is important
because Home Assistant entity IDs can have collision suffixes such as `_2`
or `_3`, and the numeric `zone_id` used by a current schedule can differ from
a historical completion sensor's ID.

A missing or invalid completion timestamp makes that zone due. An interval
of `0` means the zone is not considered for mowing.

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

## Updating

Via HACS: HACS will flag new releases like any other repo -- Update from
there, then restart (so the new card JS gets served). Manually: repeat the
"Installing manually" steps, overwriting the whole folder including `www/`,
then restart.

## Uninstalling

Settings → Devices & Services → the mower entry → **⋮** → Delete, once per
mower. This removes the entities and their stored interval values but
leaves NaviMower itself completely untouched. Then remove via HACS (or
delete the `custom_components/navimower_zone_scheduler/` folder manually)
and restart. Remove any dashboard cards separately -- deleting the
integration doesn't touch your dashboards.
