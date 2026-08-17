"""Due-zone sensor for NaviMower Zone Scheduler."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from homeassistant.exceptions import HomeAssistantError

from .const import CONF_SCHEDULE_ENTITY
from .service import _due_zone_details


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    schedule_entity = entry.data[CONF_SCHEDULE_ENTITY]
    async_add_entities([DueZonesSensor(entry, schedule_entity)])


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
