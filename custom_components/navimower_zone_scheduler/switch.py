"""Per-zone "include in scheduling" switch, discovered from a target sensor.

Whether a zone participates in the due-zone calculation (mow_due_zones,
save_due_schedule, the due-zones sensor, and the Lovelace card's preview)
used to be encoded by setting that zone's mow-interval number to 0. Now
that the interval only ever ranges 1-7, that job belongs to this switch
instead -- flip it off and the zone is skipped entirely, regardless of
its configured interval, matching exactly how interval-0 used to behave.

Zone discovery mirrors number.py exactly (same target Schedule sensor,
same `zones` attribute, same unique-id-per-zone approach) so the two stay
in lockstep as zones are added, renamed, or removed.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import CONF_SCHEDULE_ENTITY, DOMAIN, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


def _enabled_store(hass: HomeAssistant, entry_id: str) -> Store:
    return Store(hass, STORAGE_VERSION, f"{DOMAIN}_enabled_{entry_id}")


def _interval_store(hass: HomeAssistant, entry_id: str) -> Store:
    # Read-only here, purely for one-time migration -- see
    # _seed_default_from_old_interval below. number.py owns writes to it.
    return Store(hass, STORAGE_VERSION, f"{DOMAIN}_intervals_{entry_id}")


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    schedule_entity_id: str = entry.data[CONF_SCHEDULE_ENTITY]
    store = _enabled_store(hass, entry.entry_id)

    mower_label = (
        schedule_entity_id.removeprefix("sensor.")
        .removesuffix("_schedule")
        .replace("_", " ")
        .title()
    )

    enabled: dict[int, bool] = {}
    try:
        cached = await store.async_load()
    except Exception:  # noqa: BLE001 - a corrupt/missing store must not block setup
        _LOGGER.debug("Zone enabled-state restore failed", exc_info=True)
        cached = None
    had_cached_store = isinstance(cached, dict)
    if had_cached_store:
        for key, value in cached.items():
            try:
                enabled[int(key)] = bool(value)
            except (TypeError, ValueError):
                continue

    # One-time migration for existing installs: this switch is new, so on
    # the very first load its own store is empty for every zone. Rather
    # than defaulting everything to off (which would silently stop
    # scheduling every zone someone had already configured), seed each
    # zone's initial value from whether its *old* interval was > 0 -- the
    # exact condition that used to mean "considered" before this switch
    # existed. This only ever runs once: after the first save, this
    # switch's own store always has an entry for every known zone, so this
    # branch is skipped from then on, including for brand-new zones added
    # later (those fall through to the plain default of False below).
    old_intervals: dict[int, int] = {}
    if not had_cached_store:
        try:
            old_cached = await _interval_store(hass, entry.entry_id).async_load()
        except Exception:  # noqa: BLE001 - migration is best-effort only
            _LOGGER.debug("Could not read old interval store for migration", exc_info=True)
            old_cached = None
        if isinstance(old_cached, dict):
            for key, value in old_cached.items():
                try:
                    old_intervals[int(key)] = int(value)
                except (TypeError, ValueError):
                    continue

    known_zone_ids: set[int] = set()

    def _current_zones() -> list[dict[str, Any]]:
        state = hass.states.get(schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        return zones if isinstance(zones, list) else []

    def _add_new_zones() -> None:
        new_entities: list[SwitchEntity] = []
        for row in _current_zones():
            try:
                zone_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            if zone_id in known_zone_ids:
                continue
            known_zone_ids.add(zone_id)
            if zone_id not in enabled:
                enabled[zone_id] = old_intervals.get(zone_id, 0) > 0
            new_entities.append(
                ZoneMowEnabledSwitch(
                    entry, schedule_entity_id, zone_id, enabled, store, mower_label
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


class ZoneMowEnabledSwitch(SwitchEntity):
    """Whether one zone is included in due-zone scheduling at all.

    Off means this zone is skipped entirely by mow_due_zones,
    save_due_schedule, the due-zones sensor, and the card's preview --
    regardless of its configured mow-interval value. A brand-new zone
    starts off, same as the old "interval 0" default did.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:calendar-check"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        schedule_entity_id: str,
        zone_id: int,
        enabled: dict[int, bool],
        store: Store,
        mower_label: str,
    ) -> None:
        self._entry = entry
        self._schedule_entity_id = schedule_entity_id
        self._zone_id = zone_id
        self._enabled = enabled
        self._store = store
        self._mower_label = mower_label
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}_mow_enabled"

    def _zone_row(self) -> dict[str, Any]:
        state = self.hass.states.get(self._schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        if not isinstance(zones, list):
            return {}
        return next((r for r in zones if str(r.get("id")) == str(self._zone_id)), {})

    @property
    def name(self) -> str:
        zone_name = str(self._zone_row().get("name") or f"Zone {self._zone_id}")
        return f"{self._mower_label} {zone_name} mow enabled"

    @property
    def is_on(self) -> bool:
        return bool(self._enabled.get(self._zone_id, False))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "zone_id": self._zone_id,
            "zone_name": self._zone_row().get("name"),
            "source_entity": self._schedule_entity_id,
        }

    async def _async_set(self, value: bool) -> None:
        self._enabled[self._zone_id] = value
        try:
            await self._store.async_save({str(k): v for k, v in self._enabled.items()})
        except Exception:  # noqa: BLE001 - a failed write must not crash the entity
            _LOGGER.debug("Zone enabled-state save failed", exc_info=True)
        self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._async_set(False)
