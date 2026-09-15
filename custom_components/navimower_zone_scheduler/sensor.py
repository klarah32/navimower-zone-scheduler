"""Due-zone sensor for NaviMower Zone Scheduler."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store

from .const import CONF_SCHEDULE_ENTITY, DOMAIN, STORAGE_VERSION
from .select import _override_store, override_signal
from .service import _completion_entity_ids_for_zone, _due_zone_details, _history_last_state

_LOGGER = logging.getLogger(__name__)


def _floor_store(hass: HomeAssistant, entry_id: str) -> Store:
    """Per-zone "never go backwards" floor for ZoneLastCompletedSensor.

    Holds the newest completion timestamp ever accepted for each zone --
    whether that came from mirroring Navimower's own sensor or from a
    person pressing that zone's "mark completed now" button (button.py).
    Both paths only ever *raise* this floor, never lower it; the sensor's
    displayed value is always this floor, so neither a stale/disabled
    Navimower source nor a delayed cloud sync can make it regress.

    Each zone's entry is `{"value": <iso8601>, "manual": bool}` --
    `manual` is True only when the floor's current value was set by that
    button press rather than mirrored from Navimower, so the card can
    show a "(manual)" hint instead of presenting it as if it came from
    the mower. (A plain ISO string, from before this field existed, is
    still read fine -- treated as `manual: False`.)
    """
    return Store(hass, STORAGE_VERSION, f"{DOMAIN}_completed_floor_{entry_id}")


def mark_completed_signal(entry_id: str, zone_id: int) -> str:
    """Dispatcher signal a ZoneLastCompletedSensor listens on for this zone.

    Fired by button.py's ZoneMarkCompletedButton right after it raises the
    floor store for that zone, so the sensor re-reads it and updates
    immediately instead of waiting for its next periodic re-resolve.
    """
    return f"{DOMAIN}_{entry_id}_mark_completed_{zone_id}"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    schedule_entity = entry.data[CONF_SCHEDULE_ENTITY]
    async_add_entities([DueZonesSensor(entry, schedule_entity)])

    override_store = _override_store(hass, entry.entry_id)
    floor_store = _floor_store(hass, entry.entry_id)

    # Same derivation DueZonesSensor/number.py/switch.py all use.
    mower_label = (
        schedule_entity.removeprefix("sensor.")
        .removesuffix("_schedule")
        .replace("_", " ")
        .title()
    )

    known_zone_ids: set[int] = set()

    def _current_zones() -> list[dict[str, Any]]:
        state = hass.states.get(schedule_entity)
        zones = state.attributes.get("zones") if state else None
        return zones if isinstance(zones, list) else []

    def _add_new_zones() -> None:
        new_entities: list[SensorEntity] = []
        for row in _current_zones():
            try:
                zone_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            if zone_id in known_zone_ids:
                continue
            known_zone_ids.add(zone_id)
            new_entities.append(
                ZoneLastCompletedSensor(
                    entry, schedule_entity, zone_id, override_store, floor_store, mower_label
                )
            )
        if new_entities:
            async_add_entities(new_entities)

    _add_new_zones()

    @callback
    def _schedule_entity_changed(_event: Event) -> None:
        _add_new_zones()

    entry.async_on_unload(
        async_track_state_change_event(hass, [schedule_entity], _schedule_entity_changed)
    )


class DueZonesSensor(SensorEntity):
    """Expose the same due-zone calculation used by the mow service."""

    _attr_icon = "mdi:robot-mower"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, schedule_entity: str) -> None:
        self._entry = entry
        self._schedule_entity = schedule_entity
        prefix = schedule_entity.removeprefix("sensor.").removesuffix("_schedule")
        self._prefix = prefix
        self._attr_name = f"{prefix.replace('_', ' ').title()} mow due zones"
        self._attr_unique_id = f"{entry.entry_id}_mow_due_zones"
        self._attr_native_value = 0
        self._attr_extra_state_attributes: dict[str, Any] = {
            "schedule_entity": schedule_entity,
            "zone_names": [],
            "zone_ids": [],
            "due_zones": [],
            "count": 0,
            "updated_at": None,
        }
        self._update_lock = asyncio.Lock()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return self._attr_extra_state_attributes

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        # The due calculation depends on the schedule, the independent
        # per-zone interval numbers, and the mower's *_last_completed*
        # sensors. Listen to state changes for all of those rather than only
        # the schedule, so the published attribute is immediately current
        # when an interval is changed.
        # Track the entities that can change the due-zone result.
        # Use Home Assistant's supported entity-state helper.
        entity_ids = [self._schedule_entity]
        entity_ids.extend(
            state.entity_id
            for state in self.hass.states.async_all("number")
            if "mow_interval" in state.entity_id
        )
        entity_ids.extend(
            state.entity_id
            for state in self.hass.states.async_all("sensor")
            if (
                state.entity_id.startswith(f"sensor.{self._prefix}_")
                and "last_completed" in state.entity_id
            )
        )
        self.async_on_remove(
            async_track_state_change_event(
                self.hass,
                entity_ids,
                self._state_changed,
            )
        )
        self.async_on_remove(
            async_track_time_interval(
                self.hass,
                self._interval_update,
                timedelta(minutes=1),
            )
        )
        await self.async_update()

    @callback
    def _state_changed(self, event: Any) -> None:
        entity_id = event.data.get("entity_id", "")
        if (
            entity_id == self._schedule_entity
            or (
                entity_id.startswith("number.")
                and "mow_interval" in entity_id
            )
            or (
                entity_id.startswith(f"sensor.{self._prefix}_")
                and "last_completed" in entity_id
            )
        ):
            self.hass.async_create_task(self.async_update())

    async def _interval_update(self, _now: datetime) -> None:
        await self.async_update()

    async def async_update(self) -> None:
        async with self._update_lock:
            try:
                details = await _due_zone_details(self.hass, self._schedule_entity)
            except HomeAssistantError:
                # Schedule entity not there right now (e.g. navimower still
                # loading after a restart, or briefly reloading later).
                # Leave the last-known state as-is; the next state-change
                # event or the 1-minute interval will pick it back up once
                # the entity is available again.
                _LOGGER.debug(
                    "Schedule entity %s unavailable, skipping due-zone update",
                    self._schedule_entity,
                    exc_info=True,
                )
                return
            due = details["due_zones"]
            self._attr_native_value = len(due)
            self._attr_extra_state_attributes = {
                "schedule_entity": self._schedule_entity,
                "zone_names": details.get("zone_names", []),
                "zone_ids": details.get("zone_ids", []),
                "due_zones": due,
                "count": details.get("count", len(due)),
                "schedule_zone_count": details.get("schedule_zone_count", 0),
                "interval_zone_count": details.get("interval_zone_count", 0),
                "completed_zone_count": details.get("completed_zone_count", 0),
                "updated_at": dt_util.utcnow().isoformat(),
            }
            # This is a manually refreshed, non-polling entity. Without
            # explicitly writing the state, the calculated attributes can
            # remain stale/empty in Home Assistant even though the service
            # calculation itself returns the correct due zones.
            self.async_write_ha_state()


class ZoneLastCompletedSensor(SensorEntity):
    """This integration's own "<zone> last completed" timestamp.

    Mirrors whichever raw Navimower `*_last_completed` entity matches this
    zone -- device + zone-name slug, via `_completion_entity_ids_for_zone`
    in service.py, the exact same matching `mow_due_zones`/
    `save_due_schedule` already use -- or an explicit override from this
    zone's `ZoneCompletionSourceSelect` (select.py) when one is set.

    Exists so the Lovelace card (and anyone's automations) can read one
    stable, self-owned entity per zone -- matched the same synchronous,
    no-WS-call way the card already matches its own interval/enabled
    entities, via this entity's own `zone_id`/`zone_name` attributes --
    instead of re-doing device+registry+Recorder matching against
    Navimower's raw entity IDs from the browser on every render. That
    matching (and its Recorder fallback for a disabled-by-default source)
    happens here, once per update, in Python, with normal logging instead
    of being a silent client-side dead end.

    The displayed value is always the higher of (a) whatever the mirrored
    source currently resolves to and (b) this zone's persisted "floor"
    (see `_floor_store` above) -- so a stale/disabled Navimower entity, a
    delayed cloud sync, or Recorder history briefly returning an older row
    can never make the shown timestamp jump backwards on its own.

    Pressing this zone's "mark completed now" button (button.py) raises
    that floor directly, always to the current time, never an arbitrary
    past value -- which is also how a person can set this by hand. That
    press is flagged (`manual: True` in `extra_state_attributes`) so the
    card can show a "(manual)" hint instead of presenting it as if it
    came from Navimower; the flag clears itself automatically the moment
    live/historical mirrored data catches up to (or passes) that value.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:calendar-check-outline"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        schedule_entity_id: str,
        zone_id: int,
        override_store: Any,
        floor_store: Any,
        mower_label: str,
    ) -> None:
        self._entry = entry
        self._schedule_entity_id = schedule_entity_id
        self._zone_id = zone_id
        self._override_store = override_store
        self._floor_store = floor_store
        self._mower_label = mower_label
        # Stable across zone renames -- only the *name* is re-derived live.
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}_last_completed"
        self._attr_native_value = None
        self._resolved_source_entity: str | None = None
        self._manual = False
        self._tracked_entity_ids: list[str] = []
        self._untrack_states = None
        self._resolve_lock = asyncio.Lock()

    def _zone_row(self) -> dict[str, Any]:
        state = self.hass.states.get(self._schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        if not isinstance(zones, list):
            return {}
        return next((r for r in zones if str(r.get("id")) == str(self._zone_id)), {})

    @property
    def name(self) -> str:
        zone_name = str(self._zone_row().get("name") or f"Zone {self._zone_id}")
        return f"{self._mower_label} {zone_name} last completed"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "zone_id": self._zone_id,
            "zone_name": self._zone_row().get("name"),
            # Matches number.py/switch.py's "source_entity" meaning: which
            # scheduler config (Schedule sensor) this entity belongs to --
            # this is what the card's strongest-association match checks.
            "source_entity": self._schedule_entity_id,
            # Diagnostic only: the actual raw Navimower entity this
            # zone's value was last mirrored from (None until resolved,
            # or if nothing matched).
            "completion_source": self._resolved_source_entity,
            # True while the displayed value is a manual "mark completed
            # now" press (button.py) rather than mirrored from Navimower
            # -- the card shows a "(manual)" hint when this is set.
            "manual": self._manual,
        }

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                override_signal(self._entry.entry_id, self._zone_id),
                self._override_changed,
            )
        )
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                mark_completed_signal(self._entry.entry_id, self._zone_id),
                self._override_changed,
            )
        )
        self.async_on_remove(
            async_track_state_change_event(
                self.hass, [self._schedule_entity_id], self._schedule_changed
            )
        )
        self.async_on_remove(
            async_track_time_interval(self.hass, self._interval_resolve, timedelta(minutes=5))
        )
        await self._resolve(retrack=True)

    async def async_will_remove_from_hass(self) -> None:
        if self._untrack_states is not None:
            self._untrack_states()
            self._untrack_states = None

    @callback
    def _override_changed(self) -> None:
        self.hass.async_create_task(self._resolve(retrack=True))

    @callback
    def _schedule_changed(self, _event: Event) -> None:
        # Covers both a brand-new zone appearing (handled by the discovery
        # loop, not here) and, more commonly, a zone being renamed --
        # candidate entity IDs are matched by name slug, so they can
        # change even though this sensor's own zone_id/unique_id haven't.
        self.hass.async_create_task(self._resolve(retrack=True))

    async def _interval_resolve(self, _now: datetime) -> None:
        # Safety net for anything the event-driven paths above miss (e.g.
        # a brand-new completion sensor appearing on the *same* entity_id
        # this zone already resolved to nothing for). Deliberately lighter
        # than DueZonesSensor's 1-minute poll -- this only re-derives the
        # candidate list, it doesn't recompute a due-zone simulation.
        await self._resolve(retrack=False)

    async def _candidate_entity_ids(self) -> list[str]:
        zone_name = self._zone_row().get("name")
        candidates = _completion_entity_ids_for_zone(
            self.hass, self._schedule_entity_id, zone_name
        )
        try:
            overrides = await self._override_store.async_load()
        except Exception:  # noqa: BLE001 - a corrupt/missing store must not block resolution
            _LOGGER.debug("Completion override read failed", exc_info=True)
            overrides = None
        override = None
        if isinstance(overrides, dict):
            override = overrides.get(str(self._zone_id))
        if not override:
            return candidates
        # The override always wins -- tried first -- but the automatic
        # matches are kept behind it so a stale/wrong override still falls
        # back to something useful instead of showing "never completed".
        return [override, *[c for c in candidates if c != override]]

    async def _resolve(self, retrack: bool) -> None:
        async with self._resolve_lock:
            candidates = await self._candidate_entity_ids()
            if retrack:
                self._retrack(candidates)

            value = None
            source = None
            for entity_id in candidates:
                state = self.hass.states.get(entity_id)
                if state is not None and state.state not in ("unknown", "unavailable", ""):
                    parsed = dt_util.parse_datetime(state.state)
                    if parsed is not None:
                        value = dt_util.as_utc(parsed)
                        source = entity_id
                        break

            if value is None:
                for entity_id in candidates:
                    historical = await self.hass.async_add_executor_job(
                        _history_last_state, self.hass, entity_id
                    )
                    if historical is None:
                        continue
                    parsed = dt_util.parse_datetime(getattr(historical, "state", "") or "")
                    if parsed is not None:
                        value = dt_util.as_utc(parsed)
                        source = entity_id
                        break

            # Never let the displayed value regress: combine whatever the
            # mirrored source just resolved to with this zone's persisted
            # floor (raised either by an earlier, newer resolve, or by a
            # person pressing "mark completed now" -- button.py), and keep
            # whichever is newer. A stale/disabled Navimower entity or a
            # delayed cloud sync briefly reporting an older timestamp can
            # therefore never make this sensor jump backwards.
            try:
                floors = await self._floor_store.async_load()
            except Exception:  # noqa: BLE001 - a corrupt/missing store must not block resolution
                _LOGGER.debug("Completed-floor read failed", exc_info=True)
                floors = None
            if not isinstance(floors, dict):
                floors = {}
            existing_floor = None
            existing_manual = False
            raw_floor = floors.get(str(self._zone_id))
            if isinstance(raw_floor, dict):
                raw_value = raw_floor.get("value")
                existing_manual = bool(raw_floor.get("manual"))
            else:
                # Back-compat: a plain ISO string from before "manual" was
                # tracked -- always treated as an automatic value.
                raw_value = raw_floor
            if raw_value:
                parsed_floor = dt_util.parse_datetime(str(raw_value))
                if parsed_floor is not None:
                    existing_floor = dt_util.as_utc(parsed_floor)

            if value is not None and (existing_floor is None or value > existing_floor):
                floors[str(self._zone_id)] = {"value": value.isoformat(), "manual": False}
                try:
                    await self._floor_store.async_save(floors)
                except Exception:  # noqa: BLE001 - a failed write must not crash the entity
                    _LOGGER.debug("Completed-floor save failed", exc_info=True)
                self._manual = False
            elif existing_floor is not None and (value is None or existing_floor > value):
                value = existing_floor
                # The floor is currently ahead of whatever the mirrored
                # source resolved to (or nothing resolved at all) -- most
                # likely a manual "mark completed now" press, or the
                # mirrored source is temporarily stale/unavailable. Either
                # way `source` shouldn't claim to be live-mirrored data
                # right now.
                source = None
                self._manual = existing_manual
            else:
                # value == existing_floor exactly (or both None) --
                # confirmed by live/historical data, so no longer manual.
                self._manual = False

            self._attr_native_value = value
            self._resolved_source_entity = source
            self.async_write_ha_state()

    def _retrack(self, candidate_entity_ids: list[str]) -> None:
        if candidate_entity_ids == self._tracked_entity_ids:
            return
        if self._untrack_states is not None:
            self._untrack_states()
            self._untrack_states = None
        self._tracked_entity_ids = list(candidate_entity_ids)
        if candidate_entity_ids:
            self._untrack_states = async_track_state_change_event(
                self.hass, candidate_entity_ids, self._source_state_changed
            )

    @callback
    def _source_state_changed(self, _event: Event) -> None:
        self.hass.async_create_task(self._resolve(retrack=False))
