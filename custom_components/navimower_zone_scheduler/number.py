"""Per-zone mow-interval number entities, discovered from a target sensor.

Zone discovery and persistence both live here -- nothing is read from or
written to the navimower integration's own storage or Python objects. The
only touchpoint with navimower is the *state* of the Schedule sensor entity
the user pointed this config entry at (its `zones` attribute), the same way
the Lovelace card and any automation reads it.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import CONF_SCHEDULE_ENTITY, DOMAIN, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


def _zone_store(hass: HomeAssistant, entry_id: str) -> Store:
    return Store(hass, STORAGE_VERSION, f"{DOMAIN}_intervals_{entry_id}")


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    schedule_entity_id: str = entry.data[CONF_SCHEDULE_ENTITY]
    store = _zone_store(hass, entry.entry_id)

    # Same derivation DueZonesSensor uses for its own name/prefix, so the
    # mower label shown here matches the one already visible elsewhere
    # (e.g. "Eltern mow due zones"). Prepending it to each interval
    # entity's name keeps two mowers that happen to share a zone name
    # (e.g. both have a "Birnbaum" zone) from colliding on entity_id --
    # without it, HA would silently suffix the second one with "_2",
    # which is exactly the kind of mix-up this is meant to avoid.
    mower_label = (
        schedule_entity_id.removeprefix("sensor.")
        .removesuffix("_schedule")
        .replace("_", " ")
        .title()
    )

    intervals: dict[int, int] = {}
    try:
        cached = await store.async_load()
    except Exception:  # noqa: BLE001 - a corrupt/missing store must not block setup
        _LOGGER.debug("Zone interval restore failed", exc_info=True)
        cached = None
    if isinstance(cached, dict):
        for key, value in cached.items():
            try:
                intervals[int(key)] = max(0, int(value))
            except (TypeError, ValueError):
                continue

    known_zone_ids: set[int] = set()

    def _current_zones() -> list[dict[str, Any]]:
        state = hass.states.get(schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        return zones if isinstance(zones, list) else []

    def _add_new_zones() -> None:
        new_entities: list[NumberEntity] = []
        for row in _current_zones():
            try:
                zone_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            if zone_id in known_zone_ids:
                continue
            known_zone_ids.add(zone_id)
            new_entities.append(
                ZoneMowIntervalNumber(
                    entry, schedule_entity_id, zone_id, intervals, store, mower_label
                )
            )
        if new_entities:
            async_add_entities(new_entities)

    _add_new_zones()

    @callback
    def _schedule_entity_changed(_event: Event) -> None:
        # Covers both "a brand-new zone just appeared" and, more commonly,
        # "a zone got renamed" (existing entities re-read the row live, see
        # ZoneMowIntervalNumber.name, so nothing extra is needed for that
        # case beyond a state write to refresh the displayed name).
        _add_new_zones()

    entry.async_on_unload(
        async_track_state_change_event(hass, [schedule_entity_id], _schedule_entity_changed)
    )


class ZoneMowIntervalNumber(NumberEntity):
    """User-set "mow me at least every N days" preference for one zone.

    Value 0 means "not considered" (matches the interval-0 = excluded
    convention used by the navimow-zone-interval-card and any automation
    built around it). A brand-new zone starts at 0 and is immediately
    usable -- no setup step, no helper to create by hand.
    """

    _attr_has_entity_name = True
    _attr_native_min_value = 0
    _attr_native_max_value = 7
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER
    _attr_icon = "mdi:calendar-refresh"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        schedule_entity_id: str,
        zone_id: int,
        intervals: dict[int, int],
        store: Store,
        mower_label: str,
    ) -> None:
        self._entry = entry
        self._schedule_entity_id = schedule_entity_id
        self._zone_id = zone_id
        self._intervals = intervals
        self._store = store
        self._mower_label = mower_label
        # Stable across zone renames -- only the *name* is re-derived live.
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}_mow_interval"

    def _zone_row(self) -> dict[str, Any]:
        state = self.hass.states.get(self._schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        if not isinstance(zones, list):
            return {}
        return next((r for r in zones if str(r.get("id")) == str(self._zone_id)), {})

    @property
    def name(self) -> str:
        zone_name = str(self._zone_row().get("name") or f"Zone {self._zone_id}")
        # Mower label first so the entity_id (and thus the auto-generated
        # entity_id slug) is unique across mowers that share a zone name --
        # e.g. "Eltern Birnbaum mow interval" / "Gerd Birnbaum mow interval"
        # instead of both wanting "birnbaum_mow_interval".
        return f"{self._mower_label} {zone_name} mow interval"

    @property
    def native_value(self) -> float:
        return float(self._intervals.get(self._zone_id, 0))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "zone_id": self._zone_id,
            "zone_name": self._zone_row().get("name"),
            "source_entity": self._schedule_entity_id,
        }

    async def async_set_native_value(self, value: float) -> None:
        days = max(0, int(round(value)))
        self._intervals[self._zone_id] = days
        try:
            await self._store.async_save({str(k): v for k, v in self._intervals.items()})
        except Exception:  # noqa: BLE001 - a failed write must not crash the entity
            _LOGGER.debug("Zone interval save failed", exc_info=True)
        self.async_write_ha_state()
