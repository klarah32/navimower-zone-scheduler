"""Constants for the NaviMower Zone Scheduler add-on.

This integration is intentionally independent of the `navimower` custom
component: it never imports from it, never touches its files, and has no
hard `dependencies` entry on it in manifest.json. It only reads whatever
entity the user points it at (expected to be a NaviMower "Schedule" sensor,
but nothing here enforces that beyond checking for a `zones` attribute) and
calls the `navimower.set_schedule` / `navimower.mow` services the same way
any Home Assistant automation would. Update NaviMower however you like --
this add-on keeps working.
"""

DOMAIN = "navimower_zone_scheduler"
CONF_SCHEDULE_ENTITY = "schedule_entity"

STORAGE_VERSION = 1
DEFAULT_MAX_DAYS = 7
