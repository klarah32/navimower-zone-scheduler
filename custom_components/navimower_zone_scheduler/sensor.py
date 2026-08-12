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
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

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
        self.async_on_remove(
            async_track_state_change_event(
                self.hass,
                [self._schedule_entity],
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
    def _state_changed(self, _event: Any) -> None:
        self.hass.async_create_task(self.async_update())

    async def _interval_update(self, _now: datetime) -> None:
        await self.async_update()

    async def async_update(self) -> None:
        async with self._update_lock:
            details = await _due_zone_details(self.hass, self._schedule_entity)
            due = details["due_zones"]
            self._attr_native_value = len(due)
            self._attr_extra_state_attributes = {
                "schedule_entity": self._schedule_entity,
                "zone_names": [z["name"] for z in due],
                "zone_ids": [z["id"] for z in due],
                "due_zones": due,
                "count": len(due),
                "updated_at": dt_util.utcnow().isoformat(),
            }
