"""Per-zone "mark completed now" button, discovered from a target sensor.

Manually raises a zone's persisted completion "floor" (see `_floor_store`
in sensor.py) to right now, flagged so that sensor's `manual` attribute
reads True and the card can show a "(manual)" hint instead of presenting
it as if it came from Navimower. That flag clears itself automatically
once live/historical mirrored data catches up to (or passes) this value
-- pressing this button never permanently disconnects a zone from
Navimower's own reporting, it's just a "yes, this is done, right now"
that a stale/disabled entity or a delayed cloud sync can't undo either.

Deliberately only ever sets "now", not an arbitrary past timestamp --
that's what keeps it safe to combine with the floor's own "never go
backwards" rule without a separate bypass path for manual corrections.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import CONF_SCHEDULE_ENTITY
from .sensor import _floor_store, mark_completed_signal

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    schedule_entity_id: str = entry.data[CONF_SCHEDULE_ENTITY]
    floor_store = _floor_store(hass, entry.entry_id)

    # Same derivation number.py/switch.py/select.py all use.
    mower_label = (
        schedule_entity_id.removeprefix("sensor.")
        .removesuffix("_schedule")
        .replace("_", " ")
        .title()
    )

    known_zone_ids: set[int] = set()

    def _current_zones() -> list[dict[str, Any]]:
        state = hass.states.get(schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        return zones if isinstance(zones, list) else []

    def _add_new_zones() -> None:
        new_entities: list[ButtonEntity] = []
        for row in _current_zones():
            try:
                zone_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            if zone_id in known_zone_ids:
                continue
            known_zone_ids.add(zone_id)
            new_entities.append(
                ZoneMarkCompletedButton(
                    entry, schedule_entity_id, zone_id, floor_store, mower_label
                )
            )
        if new_entities:
            async_add_entities(new_entities)

    _add_new_zones()

    @callback
    def _schedule_entity_changed(_event: Event) -> None:
        _add_new_zones()

    entry.async_on_unload(
        async_track_state_change_event(hass, [schedule_entity_id], _schedule_entity_changed)
    )


class ZoneMarkCompletedButton(ButtonEntity):
    """Pins this zone's completed-sensor floor to right now, by hand."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:check-circle-outline"
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        schedule_entity_id: str,
        zone_id: int,
        floor_store: Any,
        mower_label: str,
    ) -> None:
        self._entry = entry
        self._schedule_entity_id = schedule_entity_id
        self._zone_id = zone_id
        self._floor_store = floor_store
        self._mower_label = mower_label
        # Stable across zone renames -- only the *name* is re-derived live.
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}_mark_completed"

    def _zone_row(self) -> dict[str, Any]:
        state = self.hass.states.get(self._schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        if not isinstance(zones, list):
            return {}
        return next((r for r in zones if str(r.get("id")) == str(self._zone_id)), {})

    @property
    def name(self) -> str:
        zone_name = str(self._zone_row().get("name") or f"Zone {self._zone_id}")
        return f"{self._mower_label} {zone_name} mark completed now"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "zone_id": self._zone_id,
            "zone_name": self._zone_row().get("name"),
            "source_entity": self._schedule_entity_id,
        }

    async def async_press(self) -> None:
        try:
            floors = await self._floor_store.async_load()
        except Exception:  # noqa: BLE001 - a corrupt/missing store must not block the press
            _LOGGER.debug("Completed-floor read failed", exc_info=True)
            floors = None
        if not isinstance(floors, dict):
            floors = {}
        floors[str(self._zone_id)] = {
            "value": dt_util.utcnow().isoformat(),
            "manual": True,
        }
        try:
            await self._floor_store.async_save(floors)
        except Exception:  # noqa: BLE001 - a failed write must not crash the entity
            _LOGGER.debug("Completed-floor save failed", exc_info=True)
            return
        async_dispatcher_send(
            self.hass, mark_completed_signal(self._entry.entry_id, self._zone_id)
        )
