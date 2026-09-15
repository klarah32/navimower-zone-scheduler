"""Per-zone completion-source override, discovered from a target sensor.

By default each zone's "last completed" sensor (see sensor.py's
ZoneLastCompletedSensor) is matched automatically to one of Navimower's own
`*_last_completed` entities -- purely by device + zone-name slug, via
`_completion_entity_ids_for_zone` in service.py (the exact same matching
the mow_due_zones/save_due_schedule services already use, so the card and
those services can never quietly disagree). That auto-match is right the
overwhelming majority of the time, but two zones whose names collide after
slugifying (rare, but possible after a rename in the Navimower app) can
point the wrong one at each other's sensor.

This select lets that be corrected per zone, once, centrally -- as a
regular HA entity instead of a card's dashboard-only YAML config -- so the
fix follows the zone wherever its completion sensor is shown, not just on
one specific card/dashboard.

Zone discovery mirrors number.py/switch.py exactly (same target Schedule
sensor, same `zones` attribute, same unique-id-per-zone approach) so all
three stay in lockstep as zones are added, renamed, or removed.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import CONF_SCHEDULE_ENTITY, DOMAIN, STORAGE_VERSION
from .service import _completion_entity_ids_for_zone

_LOGGER = logging.getLogger(__name__)

# Shown/selected in place of any real entity_id -- "let the automatic
# device+zone-slug match decide", the default and normal state for every
# zone that doesn't need correcting.
AUTO_OPTION = "Automatic"


def _override_store(hass: HomeAssistant, entry_id: str) -> Store:
    return Store(hass, STORAGE_VERSION, f"{DOMAIN}_completion_override_{entry_id}")


def override_signal(entry_id: str, zone_id: int) -> str:
    """Dispatcher signal a ZoneLastCompletedSensor listens on for this zone."""
    return f"{DOMAIN}_{entry_id}_completion_override_{zone_id}"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    schedule_entity_id: str = entry.data[CONF_SCHEDULE_ENTITY]
    store = _override_store(hass, entry.entry_id)

    # Same derivation number.py/switch.py use, so entities read naturally
    # together (e.g. "Eltern Birnbaum completion source" next to "Eltern
    # Birnbaum mow interval").
    mower_label = (
        schedule_entity_id.removeprefix("sensor.")
        .removesuffix("_schedule")
        .replace("_", " ")
        .title()
    )

    overrides: dict[int, str] = {}
    try:
        cached = await store.async_load()
    except Exception:  # noqa: BLE001 - a corrupt/missing store must not block setup
        _LOGGER.debug("Completion override restore failed", exc_info=True)
        cached = None
    if isinstance(cached, dict):
        for key, value in cached.items():
            if not value:
                continue
            try:
                overrides[int(key)] = str(value)
            except (TypeError, ValueError):
                continue

    known_zone_ids: set[int] = set()

    def _current_zones() -> list[dict[str, Any]]:
        state = hass.states.get(schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        return zones if isinstance(zones, list) else []

    def _add_new_zones() -> None:
        new_entities: list[SelectEntity] = []
        for row in _current_zones():
            try:
                zone_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            if zone_id in known_zone_ids:
                continue
            known_zone_ids.add(zone_id)
            new_entities.append(
                ZoneCompletionSourceSelect(
                    entry, schedule_entity_id, zone_id, overrides, store, mower_label
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


class ZoneCompletionSourceSelect(SelectEntity):
    """Manual override for which raw entity feeds one zone's completion sensor.

    Defaults to `AUTO_OPTION` (the automatic device+zone-slug match) for
    every zone -- this only needs touching for the rare zone whose name
    collides with another's after slugifying.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:target"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        schedule_entity_id: str,
        zone_id: int,
        overrides: dict[int, str],
        store: Store,
        mower_label: str,
    ) -> None:
        self._entry = entry
        self._schedule_entity_id = schedule_entity_id
        self._zone_id = zone_id
        self._overrides = overrides
        self._store = store
        self._mower_label = mower_label
        # Stable across zone renames -- only the *name* is re-derived live.
        self._attr_unique_id = f"{entry.entry_id}_zone_{zone_id}_completion_source"

    def _zone_row(self) -> dict[str, Any]:
        state = self.hass.states.get(self._schedule_entity_id)
        zones = state.attributes.get("zones") if state else None
        if not isinstance(zones, list):
            return {}
        return next((r for r in zones if str(r.get("id")) == str(self._zone_id)), {})

    @property
    def name(self) -> str:
        zone_name = str(self._zone_row().get("name") or f"Zone {self._zone_id}")
        return f"{self._mower_label} {zone_name} completion source"

    @property
    def options(self) -> list[str]:
        zone_name = self._zone_row().get("name")
        candidates = _completion_entity_ids_for_zone(
            self.hass, self._schedule_entity_id, zone_name
        )
        # The currently-selected override is always offered even if it no
        # longer matches automatically (e.g. the zone was renamed after the
        # override was set) -- otherwise picking "Automatic" would be the
        # only way to clear a now-stale-looking but still-working choice.
        current = self._overrides.get(self._zone_id)
        options = [AUTO_OPTION, *candidates]
        if current and current not in options:
            options.append(current)
        return options

    @property
    def current_option(self) -> str:
        return self._overrides.get(self._zone_id, AUTO_OPTION)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "zone_id": self._zone_id,
            "zone_name": self._zone_row().get("name"),
            "source_entity": self._schedule_entity_id,
        }

    async def async_select_option(self, option: str) -> None:
        if option == AUTO_OPTION:
            self._overrides.pop(self._zone_id, None)
        else:
            self._overrides[self._zone_id] = option
        try:
            await self._store.async_save({str(k): v for k, v in self._overrides.items()})
        except Exception:  # noqa: BLE001 - a failed write must not crash the entity
            _LOGGER.debug("Completion override save failed", exc_info=True)
        self.async_write_ha_state()
        # Nudge the paired ZoneLastCompletedSensor to re-resolve (and
        # re-subscribe to state changes on the new source entity)
        # immediately, rather than waiting for that entity's own 5-minute
        # poll or the source entity's next unrelated state change.
        async_dispatcher_send(self.hass, override_signal(self._entry.entry_id, self._zone_id))
