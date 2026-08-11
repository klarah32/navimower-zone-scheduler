"""Config flow for the NaviMower Zone Scheduler add-on."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector

from .const import CONF_SCHEDULE_ENTITY, DOMAIN


class NavimowerZoneSchedulerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Pick a mower's Schedule sensor. One config entry per mower."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            entity_id = user_input[CONF_SCHEDULE_ENTITY]
            await self.async_set_unique_id(entity_id)
            self._abort_if_unique_id_configured()

            state = self.hass.states.get(entity_id)
            if state is None:
                errors["base"] = "entity_not_found"
            elif not isinstance(state.attributes.get("zones"), list):
                # Doesn't have to literally be navimower's Schedule sensor,
                # but it must expose the same [{id, name}, ...] contract we
                # rely on to discover zones.
                errors["base"] = "no_zones_attribute"
            else:
                title = state.attributes.get("friendly_name") or entity_id
                return self.async_create_entry(title=title, data=user_input)

        schema = vol.Schema(
            {
                vol.Required(CONF_SCHEDULE_ENTITY): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="sensor")
                ),
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )
