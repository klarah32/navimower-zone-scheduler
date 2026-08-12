"""Services for NaviMower Zone Scheduler."""

from __future__ import annotations

import logging
import re
from datetime import date, timedelta
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import sun as sun_helper
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from homeassistant.components.recorder import history as recorder_history

_LOGGER = logging.getLogger(__name__)

SERVICE_MOW_DUE_ZONES = "mow_due_zones"
SERVICE_SAVE_DUE_SCHEDULE = "save_due_schedule"

# date.weekday(): Monday=0 .. Sunday=6, matching navimower.set_schedule's
# lowercase English weekday names.
_WEEKDAY_EN = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]

# navimow's set_schedule only accepts start/end times on a 15-minute raster
# (:00/:15/:30/:45). A fixed "HH:MM" must already land on it; a sun-relative
# spec ("sunrise", "sunset+30", "sunrise-45" -- offset in whole minutes) is
# resolved against the real sunrise/sunset for the day being scheduled and
# then snapped to the nearest mark, since astral times never land on it
# naturally.
_RASTER_MINUTES = 15

_FIXED_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_SUN_SPEC_RE = re.compile(r"^(sunrise|sunset)\s*(?:([+-])\s*(\d{1,4}))?$", re.IGNORECASE)


def _validate_time_spec(value: str) -> str:
    """Schema-time syntax check for a start/end field.

    Accepts the two forms _resolve_time_spec understands. This only checks
    shape (no hass/date available yet at schema-validation time) -- actually
    resolving "sunrise"/"sunset" against a real date happens per simulated
    day in async_handle_save_due_schedule.
    """
    value = value.strip()
    if _FIXED_TIME_RE.match(value) or _SUN_SPEC_RE.match(value):
        return value
    raise vol.Invalid(
        f"Invalid time {value!r} -- use HH:MM on a 15-minute mark, "
        "'sunrise'/'sunset', or an offset in minutes like 'sunset-30'"
    )


MOW_DUE_SCHEMA = vol.Schema(
    {
        vol.Required("schedule_entity"): cv.entity_id,
        vol.Required("device_id"): cv.string,
        vol.Optional("reset", default=False): cv.boolean,
    }
)

SAVE_DUE_SCHEDULE_SCHEMA = vol.Schema(
    {
        vol.Required("schedule_entity"): cv.entity_id,
        vol.Required("device_id"): cv.string,
        vol.Required("start"): vol.All(cv.string, _validate_time_spec),
        vol.Required("end"): vol.All(cv.string, _validate_time_spec),
        vol.Optional("days", default=7): vol.All(int, vol.Range(min=1, max=7)),
    }
)


def _round_to_raster(minutes_of_day: int) -> int:
    """Round to the nearest 15-minute mark, wrapped into a single day.

    The modulo handles both a negative offset pushing past midnight
    ("sunrise-30" just after 00:00) and rounding 23:53 up to 24:00 -- both
    collapse back into the valid 00:00-23:45 range rather than erroring.
    """
    rounded = round(minutes_of_day / _RASTER_MINUTES) * _RASTER_MINUTES
    return rounded % (24 * 60)


def _minutes_to_hhmm(minutes_of_day: int) -> str:
    hours, minutes = divmod(minutes_of_day, 60)
    return f"{hours:02d}:{minutes:02d}"


def _resolve_time_spec(hass: HomeAssistant, spec: str, for_date: date) -> str:
    """Resolve a start/end spec to a raster-aligned "HH:MM" for a real date.

    Sun-relative specs are resolved against `for_date` -- the actual
    calendar day being scheduled, not "today" -- so a schedule an
    automation regenerates daily stays accurate as sunrise/sunset drift
    through the year, rather than freezing in whatever the sun looked like
    on the day the automation happened to run.
    """
    fixed = _FIXED_TIME_RE.match(spec)
    if fixed:
        minutes_of_day = int(fixed.group(1)) * 60 + int(fixed.group(2))
        return _minutes_to_hhmm(_round_to_raster(minutes_of_day))

    sun_match = _SUN_SPEC_RE.match(spec)
    if sun_match:
        event = sun_match.group(1).lower()
        sign = sun_match.group(2)
        magnitude = sun_match.group(3)
        offset_minutes = int(magnitude) if magnitude else 0
        if sign == "-":
            offset_minutes = -offset_minutes

        event_dt = sun_helper.get_astral_event_date(hass, event, for_date)
        if event_dt is None:
            raise HomeAssistantError(
                f"Could not determine {event} for {for_date} -- the mower's "
                "location may be at a latitude with no sunrise/sunset that day, "
                "or the 'sun' integration isn't set up."
            )

        local_dt = dt_util.as_local(event_dt) + timedelta(minutes=offset_minutes)
        minutes_of_day = local_dt.hour * 60 + local_dt.minute
        return _minutes_to_hhmm(_round_to_raster(minutes_of_day))

    # Unreachable in normal operation -- the schema already rejected
    # anything that doesn't match one of the two forms above.
    raise HomeAssistantError(f"Invalid time {spec!r}")


def _zone_id(row: Any) -> int | None:
    """Return a valid positive zone ID from a schedule row."""
    if not isinstance(row, dict):
        return None
    try:
        value = int(row.get("id"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _interval_entity(hass: HomeAssistant, zone_id: int) -> str | None:
    """Find a "<zone> mow interval" number entity for a zone.

    REVIEWED against the dashboard card's _findInterval(): the card matches
    purely on domain (number.*) + "mow_interval" substring + zone_id
    attribute -- nothing else. This used to also require
    attrs.get("source_entity") == schedule_entity, which only ever exists
    on entities created by this add-on's own number.py. Any zone whose
    interval entity instead came from a directly-patched navimower
    number.py (no "source_entity" attribute at all) matched in the card but
    never matched here -- silently zero due zones, every time. Matching the
    card's exact strategy fixes that and keeps the two permanently in sync
    regardless of which integration created the entity.

    Trade-off worth knowing: like the card, this has no per-mower scoping,
    so if two different mowers ever reuse the same numeric zone_id, either
    could return the wrong mower's entity. Not observed as an issue in
    practice, but if it ever is, scoping both the card and this function by
    schedule_entity/mower would need to happen together, not just here.
    """
    for state in hass.states.async_all("number"):
        if "mow_interval" not in state.entity_id:
            continue
        attrs = state.attributes
        try:
            if int(attrs.get("zone_id")) != zone_id:
                continue
        except (TypeError, ValueError):
            continue
        if state.state in ("unknown", "unavailable", ""):
            continue
        return state.entity_id
    return None


def _interval_days(hass: HomeAssistant, interval_entity: str) -> float | None:
    """Read an interval entity's current value defensively.

    BUG FIX: this used to do `hass.states[interval_entity].state`, but
    HomeAssistant's real StateMachine has no `__getitem__` -- only `.get()`
    -- so that line raised `TypeError: 'StateMachine' object is not
    subscriptable` on every call that actually found a matching entity
    (i.e. normal operation). That's the reason mow_due_zones didn't work.
    Also now tolerates a missing/removed entity and a non-numeric state
    instead of letting either take down the whole service call.
    """
    state = hass.states.get(interval_entity)
    if state is None or state.state in ("unknown", "unavailable", ""):
        return None
    try:
        return float(state.state)
    except (TypeError, ValueError):
        return None


def _norm_name(value: Any) -> str:
    return str(value or "").strip().casefold()


def _slugify_zone_name(value: Any) -> str:
    import re
    import unicodedata

    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text


def _last_completed_state(
    hass: HomeAssistant, schedule_entity: str, zone_name: str | None = None
) -> Any | None:
    """Find the mower's completion sensor by mower prefix + zone name.

    Navimower can create entity IDs such as
    ``sensor.eltern_zone_1_last_completed_3``. The numeric zone ID in that
    entity ID is not a reliable link to the current schedule zone. The
    reliable relationship is the mower prefix plus the sensor's ``zone_name``
    attribute.
    """
    wanted_name = _norm_name(zone_name)
    if not wanted_name:
        return None

    schedule_prefix = schedule_entity.removeprefix("sensor.").removesuffix("_schedule")
    prefix = f"sensor.{schedule_prefix}_"
    pattern = re.compile(r"_last_completed(?:_\d+)?$")

    best = None
    best_ts = float("-inf")
    for state in hass.states.async_all("sensor"):
        eid = state.entity_id
        if not eid.startswith(prefix) or not pattern.search(eid):
            continue
        if _norm_name(state.attributes.get("zone_name")) != wanted_name:
            continue
        value = str(state.state or "")
        if value in ("unknown", "unavailable", ""):
            continue
        parsed = dt_util.parse_datetime(value)
        ts = parsed.timestamp() if parsed is not None else float("-inf")
        if best is None or ts > best_ts:
            best = state
            best_ts = ts

    return best


def _registry_completion_entities(
    hass: HomeAssistant, schedule_entity: str, zone_id: int, zone_name: str | None
) -> list[str]:
    """Find all registered completion sensors for this mower + zone name."""
    registry = er.async_get(hass)
    schedule_entry = registry.async_get(schedule_entity)
    device_id = schedule_entry.device_id if schedule_entry else None
    wanted_name = _norm_name(zone_name)
    schedule_prefix = schedule_entity.removeprefix("sensor.").removesuffix("_schedule")
    prefix = f"sensor.{schedule_prefix}_"
    pattern = re.compile(r"_last_completed(?:_\d+)?$")
    result: list[str] = []

    for entry in registry.entities.values():
        if entry.domain != "sensor" or not entry.entity_id.startswith(prefix):
            continue
        if device_id and entry.device_id and entry.device_id != device_id:
            continue
        if not pattern.search(entry.entity_id):
            continue
        original = _norm_name(entry.original_name or entry.name)
        if wanted_name and original == f"{wanted_name} last completed":
            result.append(entry.entity_id)

    return list(dict.fromkeys(result))


def _history_last_state(hass: HomeAssistant, entity_id: str) -> Any | None:
    """Return the newest recorded non-unknown state for an entity."""
    start = dt_util.now() - timedelta(days=5 * 365)
    try:
        rows = recorder_history.state_changes_during_period(
            hass,
            start,
            entity_id=entity_id,
            include_start_time_state=True,
        )
    except Exception:  # noqa: BLE001 - history is only a fallback
        _LOGGER.debug("Recorder lookup failed for %s", entity_id, exc_info=True)
        return None

    states = rows.get(entity_id) or []
    for state in reversed(states):
        value = getattr(state, "state", None)
        if value and value not in ("unknown", "unavailable", ""):
            return state
    return None


async def _latest_completion(
    hass: HomeAssistant, schedule_entity: str, zone_id: int, zone_name: str | None
) -> date | None:
    """Return the latest completion date, including Recorder-only history."""
    state = _last_completed_state(hass, schedule_entity, zone_name)
    if state is not None and state.state not in ("unknown", "unavailable", ""):
        parsed = dt_util.parse_datetime(state.state)
        if parsed is not None:
            return dt_util.as_local(parsed).date()

    for entity_id in _registry_completion_entities(hass, schedule_entity, zone_id, zone_name):
        historical = await hass.async_add_executor_job(_history_last_state, hass, entity_id)
        if historical is None:
            continue
        parsed = dt_util.parse_datetime(getattr(historical, "state", ""))
        if parsed is not None:
            return dt_util.as_local(parsed).date()

    return None


async def _eligible_zones(
    hass: HomeAssistant, schedule_entity: str
) -> tuple[dict[int, int], dict[int, date], dict[int, date | None]]:
    """Collect zones with interval > 0, their next-due date, and last completion.

    Returns (interval_days_by_zone, next_due_by_zone, last_completed_by_zone).
    A zone with no completion history yet is due immediately (today), and
    its last-completed entry is None. Shared by both services so "mow due
    now" and "save the next N days" agree on exactly which zones qualify
    and when.
    """
    schedule = hass.states.get(schedule_entity)
    if schedule is None:
        raise HomeAssistantError(f"Schedule entity {schedule_entity!r} was not found")

    zones = schedule.attributes.get("zones")
    if not isinstance(zones, list):
        raise HomeAssistantError(
            f"Schedule entity {schedule_entity!r} has no usable 'zones' attribute"
        )

    today = dt_util.now().date()
    intervals: dict[int, int] = {}
    next_due: dict[int, date] = {}
    last_completed_by_zone: dict[int, date | None] = {}

    for row in zones:
        zone_id = _zone_id(row)
        if zone_id is None:
            continue

        interval_entity = _interval_entity(hass, zone_id)
        if interval_entity is None:
            continue

        raw_days = _interval_days(hass, interval_entity)
        if raw_days is None or raw_days <= 0:
            continue
        interval_days = int(raw_days)

        last_completed = await _latest_completion(hass, schedule_entity, zone_id, row.get("name"))
        intervals[zone_id] = interval_days
        last_completed_by_zone[zone_id] = last_completed
        next_due[zone_id] = (
            last_completed + timedelta(days=interval_days) if last_completed else today
        )

    return intervals, next_due, last_completed_by_zone


async def _due_zone_ids(hass: HomeAssistant, schedule_entity: str) -> list[int]:
    """Calculate today's due zones for one schedule sensor."""
    today = dt_util.now().date()
    _intervals, next_due, _last_completed = await _eligible_zones(hass, schedule_entity)
    due = [zone_id for zone_id, due_date in next_due.items() if due_date <= today]
    # Defensive guarantee for navimower.mow: only positive integers leave here.
    return [zone_id for zone_id in due if isinstance(zone_id, int) and zone_id > 0]


async def _simulate_due_schedule(
    hass: HomeAssistant, schedule_entity: str, days: int
) -> dict[date, list[int]]:
    """Simulate which zones would be due on each of the next `days` days.

    Starts tomorrow, not today -- writing a recurring navimower.set_schedule
    slot for "today" is pointless once part of the day may have already
    elapsed; use mow_due_zones for an immediate today action instead.

    A zone due today or overdue is only treated as "handled" (its next
    projected due date advanced by its own interval) if it has *actually*
    been completed today -- not merely assumed, since mow_due_zones might
    run later, fail, get rained out, etc. A zone that's due but not yet
    mowed today stays due, which means it naturally carries into
    tomorrow's projection too as a safety net: if today's mow doesn't
    happen, tomorrow's saved schedule still covers that zone. Once a day
    *does* flag a zone due, that zone's next projected due date advances
    by its own interval from that day -- the same carry-forward model the
    dashboard card's preview uses, so an automation calling this produces
    the same result the card would show.
    """
    today = dt_util.now().date()
    intervals, next_due, last_completed_by_zone = await _eligible_zones(hass, schedule_entity)

    for zone_id, due_date in list(next_due.items()):
        if due_date <= today and last_completed_by_zone.get(zone_id) == today:
            next_due[zone_id] = today + timedelta(days=intervals[zone_id])
        # else: leave next_due as-is (<= today) -- either not due yet
        # today's cutoff was reached but the mow hasn't happened, so it
        # rolls forward and shows up starting with tomorrow's projection.

    schedule_by_day: dict[date, list[int]] = {}
    for offset in range(1, days + 1):
        day = today + timedelta(days=offset)
        due_ids = [zid for zid, due_date in next_due.items() if due_date <= day]
        if due_ids:
            schedule_by_day[day] = due_ids
        for zid in due_ids:
            next_due[zid] = day + timedelta(days=intervals[zid])

    return schedule_by_day


async def async_handle_mow_due_zones(hass: HomeAssistant, call: ServiceCall) -> None:
    """Mow every zone whose configured interval has elapsed."""
    schedule_entity = call.data["schedule_entity"]
    device_id = call.data["device_id"]
    reset = call.data["reset"]

    if not hass.services.has_service("navimower", "mow"):
        raise HomeAssistantError("The navimower.mow service is not available")

    due_zones = await _due_zone_ids(hass, schedule_entity)
    if not due_zones:
        _LOGGER.info("No due zones for %s", schedule_entity)
        return

    _LOGGER.info("Mowing due zones for %s: %s", schedule_entity, due_zones)

    await hass.services.async_call(
        "navimower",
        "mow",
        {
            "device_id": device_id,
            "zones": due_zones,
            "reset": reset,
        },
        blocking=True,
    )


async def async_handle_save_due_schedule(hass: HomeAssistant, call: ServiceCall) -> None:
    """Write navimower.set_schedule for each of the next N days with due zones.

    Only the days that actually have a zone due get written -- days with
    nothing due are left completely untouched, so any other periods you
    (or the app) configured for those weekdays survive. Since
    navimower.set_schedule overwrites a weekday's *entire* plan, only call
    this from an automation you're confident should own that weekday.

    `start`/`end` accept either a fixed "HH:MM" or a sun-relative spec
    ("sunrise", "sunset+30", "sunrise-45" -- offset in minutes). Each is
    resolved separately per scheduled day against *that day's* real
    sunrise/sunset (not "today's"), then snapped to the nearest 15-minute
    mark -- the only raster navimower.set_schedule accepts -- so a "start
    at sunset-30" schedule keeps tracking sunset correctly as the seasons
    shift, instead of freezing at whatever time it resolved to on the day
    the automation happened to run.
    """
    schedule_entity = call.data["schedule_entity"]
    device_id = call.data["device_id"]
    start_spec = call.data["start"]
    end_spec = call.data["end"]
    days = call.data["days"]

    if not hass.services.has_service("navimower", "set_schedule"):
        raise HomeAssistantError("The navimower.set_schedule service is not available")

    schedule_by_day = await _simulate_due_schedule(hass, schedule_entity, days)
    if not schedule_by_day:
        _LOGGER.info("No zones due in the next %s day(s) for %s", days, schedule_entity)
        return

    for day in sorted(schedule_by_day):
        zone_ids = schedule_by_day[day]
        weekday = _WEEKDAY_EN[day.weekday()]
        start = _resolve_time_spec(hass, start_spec, day)
        end = _resolve_time_spec(hass, end_spec, day)
        _LOGGER.info(
            "Saving schedule for %s (%s): %s-%s zones=%s",
            weekday, day, start, end, zone_ids,
        )
        await hass.services.async_call(
            "navimower",
            "set_schedule",
            {
                "device_id": device_id,
                "day": weekday,
                "enabled": True,
                "periods": [{"start": start, "end": end, "zones": zone_ids}],
            },
            blocking=True,
        )


def async_register_services(hass: HomeAssistant) -> None:
    """Register integration services."""
    if not hass.services.has_service("navimower_zone_scheduler", SERVICE_MOW_DUE_ZONES):

        async def _handle_mow(call: ServiceCall) -> None:
            await async_handle_mow_due_zones(hass, call)

        hass.services.async_register(
            "navimower_zone_scheduler",
            SERVICE_MOW_DUE_ZONES,
            _handle_mow,
            schema=MOW_DUE_SCHEMA,
        )

    if not hass.services.has_service("navimower_zone_scheduler", SERVICE_SAVE_DUE_SCHEDULE):

        async def _handle_save(call: ServiceCall) -> None:
            await async_handle_save_due_schedule(hass, call)

        hass.services.async_register(
            "navimower_zone_scheduler",
            SERVICE_SAVE_DUE_SCHEDULE,
            _handle_save,
            schema=SAVE_DUE_SCHEDULE_SCHEMA,
        )
