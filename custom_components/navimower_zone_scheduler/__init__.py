"""NaviMower Zone Scheduler -- a standalone add-on integration.

Adds two entities per zone (both auto-discovered from a target Schedule
sensor's `zones` attribute): a "<zone> mow interval" number (1-7 days) and
a "<zone> mow enabled" switch that controls whether the zone is considered
for scheduling at all -- a brand-new zone starts disabled, same as the old
"interval 0" default did before the switch existed. Entirely independent
of the navimower integration's own source; see const.py for why that
separation matters.

Also self-registers its companion Lovelace card (bundled under www/) as a
frontend resource on startup -- same "the integration owns its card, no
manual dashboard-resource step" pattern as navimow_pro's own _CARDS
registration -- so a HACS/manual install is enough on its own.

The card ships as two files: a tiny registration shim
(navimow-zone-interval-card.js), which is the only one actually wired up
via `add_extra_js_url()` below, and the real implementation
(navimow-zone-interval-card-impl.js), which the shim lazily loads itself
via dynamic import() once it's already registered the custom element.
See the shim's own header comment for why that split exists (in short:
so the file racing against Lovelace's dashboard render at frontend
startup is small enough to reliably win that race, and the heavy part
gets to load -- and retry -- on its own time without that race mattering
to Lovelace at all). Both are served as static paths here so the shim's
import() URL resolves; only the shim needs `add_extra_js_url()`.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.loader import async_get_integration

from .const import CONF_SCHEDULE_ENTITY, DOMAIN
from .service import async_register_services

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["button", "number", "select", "sensor", "switch"]

# This integration is config-flow-only (added via Settings -> Devices &
# Services, not configuration.yaml). This tells hassfest and HA itself
# that YAML configuration for this domain isn't supported, which is what
# the "must define CONFIG_SCHEMA/PLATFORM_SCHEMA/..." hassfest warning
# was asking for.
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_CARD_FILENAME = "navimow-zone-interval-card.js"
_CARD_IMPL_FILENAME = "navimow-zone-interval-card-impl.js"
_CARD_URL_BASE = "/navimower_zone_scheduler_static"
_CARD_URL = f"{_CARD_URL_BASE}/{_CARD_FILENAME}"
_CARD_IMPL_URL = f"{_CARD_URL_BASE}/{_CARD_IMPL_FILENAME}"

# On a full HA restart, this integration (no heavy I/O of its own) routinely
# finishes loading before navimower's own cloud-backed sensors exist yet,
# even with after_dependencies set in manifest.json -- after_dependencies
# only orders *setup*, it doesn't wait for navimower's first cloud poll to
# land. Poll briefly for the schedule sensor to show up with usable data
# before giving up and asking HA to retry the whole entry later, so a
# normal restart doesn't need a slow backoff retry just to wait a few
# seconds for another integration's first update.
_STARTUP_POLL_ATTEMPTS = 10
_STARTUP_POLL_INTERVAL = 1.0


async def _wait_for_schedule_entity(hass: HomeAssistant, schedule_entity_id: str) -> bool:
    """Return True once the schedule sensor has a usable `zones` attribute."""
    for _ in range(_STARTUP_POLL_ATTEMPTS):
        state = hass.states.get(schedule_entity_id)
        if state is not None and isinstance(state.attributes.get("zones"), list):
            return True
        await asyncio.sleep(_STARTUP_POLL_INTERVAL)
    return False


async def async_setup(hass: HomeAssistant, _config: dict) -> bool:
    """Register the integration-wide services (mow_due_zones, save_due_schedule).

    Domain-level, not per-config-entry: these services don't need a
    specific mower picked ahead of time -- schedule_entity/device_id are
    passed per call -- so they're available as soon as the integration is
    installed, before any mower has even been added via the config flow.
    """
    async_register_services(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card JS and inject it on every dashboard.

    Idempotent across config entries (one mower = one entry, but the card
    only needs registering once) and across a HA restart (registering the
    same static path/extra JS URL twice is harmless, but we still guard it
    to keep the log quiet and avoid the frontend loading the module twice).

    Multiple mowers means multiple config entries, and HA sets those up
    concurrently -- so the registered-check-then-register section below
    must be serialized with a lock. Without it, two entries can both read
    "_card_registered" as False before either finishes awaiting
    registration, and both race to register the same static path, which
    is what threw "Added route will never be executed, method GET is
    already registered" for every entry after the first.

    The extra JS URL is registered with a `?v=<manifest version>` query
    string -- read fresh from manifest.json via the integration loader,
    never hand-duplicated as a separate constant -- so the version the
    card displays (see CARD_VERSION in the JS file) can't drift out of
    sync with the installed integration version, and so a version bump
    also naturally busts any browser cache of the previous card JS.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_card_registered"):
        return

    lock = domain_data.setdefault("_card_registration_lock", asyncio.Lock())
    async with lock:
        # Re-check now that we hold the lock: another entry may have
        # finished registering while we were waiting for it.
        if domain_data.get("_card_registered"):
            return

        www_dir = Path(__file__).parent / "www"
        card_path = str(www_dir / _CARD_FILENAME)
        card_impl_path = str(www_dir / _CARD_IMPL_FILENAME)

        try:
            # HA 2024.7+: async, list-of-StaticPathConfig. Both files are
            # registered in one call -- the shim needs to be reachable for
            # add_extra_js_url() below, and the impl file needs to be
            # reachable for the shim's own dynamic import() of it.
            from homeassistant.components.http import StaticPathConfig

            await hass.http.async_register_static_paths(
                [
                    StaticPathConfig(_CARD_URL, card_path, cache_headers=False),
                    StaticPathConfig(_CARD_IMPL_URL, card_impl_path, cache_headers=False),
                ]
            )
        except ImportError:
            # Older core: sync helper, deprecated but still present.
            hass.http.register_static_path(_CARD_URL, card_path, cache_headers=False)
            hass.http.register_static_path(_CARD_IMPL_URL, card_impl_path, cache_headers=False)
        except Exception:  # noqa: BLE001 - never let card registration block setup
            _LOGGER.warning(
                "Could not register the navimow-zone-interval-card static paths; "
                "add %s manually under Settings -> Dashboards -> Resources",
                _CARD_URL,
                exc_info=True,
            )
            return

        try:
            integration = await async_get_integration(hass, DOMAIN)
            card_version = integration.version or "dev"
        except Exception:  # noqa: BLE001 - a missing/unreadable version is cosmetic only
            _LOGGER.debug(
                "Could not read manifest version for the card; falling back to 'dev'",
                exc_info=True,
            )
            card_version = "dev"

        card_url = f"{_CARD_URL}?v={card_version}"
        add_extra_js_url(hass, card_url)
        domain_data["_card_registered"] = True
        _LOGGER.debug("Registered navimow-zone-interval-card at %s", card_url)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    schedule_entity_id = entry.data[CONF_SCHEDULE_ENTITY]
    if not await _wait_for_schedule_entity(hass, schedule_entity_id):
        # Most likely a slow/still-loading navimower on this restart, but
        # could also be a genuinely deleted/renamed entity -- either way,
        # ConfigEntryNotReady makes HA retry this entry on its own backoff
        # schedule (visible in Settings -> Devices & Services as "not
        # ready, retrying") rather than the entry finishing "successfully"
        # with zero zone entities that only fill in later.
        raise ConfigEntryNotReady(
            f"{schedule_entity_id} has no 'zones' data yet "
            "(is the navimower integration still loading?)"
        )

    await _async_register_card(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    # The static path / extra JS URL is left registered even if the last
    # mower entry is removed -- harmless (an unused module script), and
    # avoids the frontend flashing an unavailable-resource error for anyone
    # with the card still placed on a dashboard.
    return unloaded
