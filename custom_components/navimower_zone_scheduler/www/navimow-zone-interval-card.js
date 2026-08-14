/**
 * navimow-zone-interval-card
 *
 * One row per zone: zone name (greyed out at interval 0, highlighted green
 * when overdue for its own configured interval), how long ago it was last
 * fully completed (full-coverage finish, not just any mowing activity,
 * measured in calendar days -- "yesterday" means the calendar day before
 * today, not "less than 48 rolling hours ago"), and a slider for the
 * desired mow interval (days) -- all read from entities matched by each
 * entity's `zone_id` attribute rather than by guessing an entity_id from
 * the zone's name (so renaming a zone in the app never breaks the match).
 * This matching strategy is deliberately mirrored exactly by the
 * `navimower_zone_scheduler.mow_due_zones` / `save_due_schedule` services,
 * so the card and any automation calling those services always agree on
 * which zones are due.
 *
 * Right below the zone rows, a standalone "Mow due zones now" button
 * starts mowing today's due zones immediately (navimower.mow) -- it does
 * NOT require opening the 7-day preview first, it computes today's due
 * list fresh on click.
 *
 * A "Preview next 7 days" button simulates which zones would be due each
 * of the *next* 7 days -- starting tomorrow, not today, since writing a
 * recurring schedule slot for "today" is pointless once part of the day
 * may already have elapsed (that's what the Mow-now button above is for).
 * A zone due today only drops out of tomorrow's projection once it's
 * *actually* been completed today -- not just assumed -- so a zone that
 * doesn't get mowed today (Mow-now skipped, failed, rained out) safely
 * carries forward into tomorrow's preview/save too, matching the backend
 * save_due_schedule service's own simulation exactly.
 * "Save to mower" always recomputes the simulation immediately before
 * saving -- so a panel left open for a while (a zone finished via the app,
 * a slider dragged on another device, etc.) can't save a stale schedule --
 * then writes only the days that actually have zones due, via
 * navimower.set_schedule, one call per weekday -- leaving days with
 * nothing due untouched, after a confirmation step listing exactly which
 * weekdays will be overwritten.
 *
 * The preview auto-refreshes the instant you drag a zone's interval slider
 * or use Mow-now, without waiting for Home Assistant's round trip back:
 * dragging a slider records the new value in a small local-override map
 * consulted by the same zone lookup the rows AND the preview both use, so
 * the simulation reflects your edit immediately; the override is dropped
 * automatically once the real entity state catches up.
 *
 * No manual helper creation needed: a brand-new zone gets its interval
 * entity automatically (defaulting to 0 = not considered) as soon as the
 * integration sees it, exactly like its "last completed" sensor. If a zone
 * somehow has no interval entity yet, its row shows a note instead of a
 * slider so nothing is silently skipped.
 *
 * The zone list itself is read live from the mower's "Schedule" sensor
 * (`sensor.<mower>_schedule`), whose `zones` attribute is `[{id, name}, ...]`
 * -- so zones automatically appear/disappear here as they do on the mower,
 * no YAML edits needed when you re-map the garden.
 *
 * Implementation note on the time-range fields: the DOM is built ONCE in
 * _build(). _render() and _renderPreview() only ever update existing
 * nodes' text/value/visibility -- they never call innerHTML on a container
 * that holds a live <input>, and _renderPreview() additionally refuses to
 * write .value into a time input that currently has focus. An earlier
 * version rebuilt the whole card on every hass push (which can arrive
 * every few seconds while a mower is active) and lost focus out of
 * whatever field was being edited; permanent nodes plus the focus check
 * fix that at the root instead of trying to guess when it's "safe" to
 * rebuild.
 *
 * Usage in a dashboard:
 *   type: custom:navimow-zone-interval-card
 *   entity: sensor.gerd_schedule      # the mower's Schedule sensor
 *   title: "Gerd - mow interval per zone"  # optional
 *   device_id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # needed to Save/Mow-now
 *   start: "09:00"                    # optional, preview/save window start
 *   end: "20:00"                      # optional, preview/save window end
 *   entity_overrides:                 # optional, see below
 *     birnbaum: sensor.garten_eltern_birnbaum_last_completed_2
 *
 * entity_overrides pins a zone's "last completed" sensor explicitly,
 * bypassing the automatic mower-prefix + zone_name match in
 * _findLastCompleted() below. Keyed by the zone's name, trimmed and
 * lower-cased (accents/case differences in the key itself still need to
 * match -- the visual editor's "Advanced entity overrides" panel writes
 * this for you, so hand-editing YAML this way is normally unnecessary).
 * Only affects what this card displays/computes (age, overdue highlight,
 * Mow-now, the 7-day preview); the navimower_zone_scheduler.mow_due_zones
 * / save_due_schedule services and the due-zones sensor still use their
 * own backend auto-discovery in service.py and don't see this override.
 */

const CARD_VERSION = "1.3.17"

class NavimowZoneIntervalCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) {
      throw new Error(
        "navimow-zone-interval-card: please set 'entity' to a mower's Schedule sensor (sensor.xxx_schedule)"
      );
    }
    this._config = {
      title: "Mow interval per zone",
      start: "09:00",
      end: "20:00",
      ...config,
    };
    if (!this._built) this._build();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    const zones =
      this._hass &&
      this._hass.states[this._config && this._config.entity] &&
      this._hass.states[this._config.entity].attributes.zones;
    return 1 + Math.max(1, (zones || []).length) * 0.6;
  }

  static getConfigElement() {
    return document.createElement("navimow-zone-interval-card-editor");
  }

  static getStubConfig(hass) {
    const states = (hass && hass.states) || {};
    const entity =
      Object.keys(states).find((e) => e.startsWith("sensor.") && e.endsWith("_schedule")) || "";
    return {
      entity,
      title: "Mow interval per zone",
      start: "09:00",
      end: "20:00",
    };
  }

  // ---------------------------------------------------------------- build
  /** Builds the entire DOM exactly once. Every element that can hold user
   *  focus (the time inputs, and via delegation the per-zone sliders) is
   *  created here and never recreated -- later updates only ever touch an
   *  existing node's .value/.textContent/.hidden, so nothing can steal
   *  focus out of a field the user is actively editing. */
  _build() {
    this._built = true;
    this.innerHTML = `
      <ha-card>
        <div class="nmz-title-row">
          <div class="nmz-title"></div>
          <div class="nmz-version">v${CARD_VERSION}</div>
        </div>
        <div class="nmz-rows"></div>
        <div class="nmz-actions">
          <button class="nmz-btn nmz-btn-mownow">Mow due zones now</button>
          <span class="nmz-mownow-status"></span>
        </div>
        <div class="nmz-actions">
          <button class="nmz-btn nmz-btn-preview">Preview next 7 days (from tomorrow)</button>
        </div>
        <div class="nmz-preview" hidden>
          <div class="nmz-preview-rows"></div>
          <div class="nmz-actions">
            <label class="nmz-time-label">from <input type="time" class="nmz-time nmz-time-start" /></label>
            <label class="nmz-time-label">to <input type="time" class="nmz-time nmz-time-end" /></label>
            <button class="nmz-btn nmz-btn-save">Save to mower</button>
          </div>
          <div class="nmz-actions"><span class="nmz-status"></span></div>
        </div>
      </ha-card>
      <style>
        ha-card { padding: 8px 12px 10px; }
        .nmz-title-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 2px;
        }
        .nmz-title {
          font-size: 13px; font-weight: 600;
          color: var(--primary-text-color, #212121);
        }
        .nmz-version {
          font-size: 10px;
          font-weight: 500;
          color: var(--secondary-text-color, #727272);
          white-space: nowrap;
        }
        .nmz-empty {
          font-size: 13px; opacity: 0.7;
          color: var(--primary-text-color, #212121);
        }
        .nmz-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto 90px 24px;
          align-items: center;
          column-gap: 8px;
          padding: 3px 0;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.07));
        }
        .nmz-row:first-of-type { border-top: none; }
        .nmz-name {
          font-size: 13px; font-weight: 500;
          color: var(--primary-text-color, #212121);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .nmz-name.nmz-overdue {
          background: rgba(76, 175, 80, 0.28);
          border-radius: 4px;
          padding: 1px 5px;
          margin-left: -5px;
        }
        .nmz-name.nmz-zero {
          opacity: 0.45;
          font-style: italic;
        }
        .nmz-age {
          font-size: 11px;
          color: var(--secondary-text-color, #757575);
          white-space: nowrap;
        }
        .nmz-slider-wrap {
          display: contents;
        }
        .nmz-slider {
          width: 90px;
          height: 18px;
          margin: 0;
          accent-color: var(--primary-color, #03a9f4);
        }
        .nmz-value {
          font-size: 11px; font-weight: 600; text-align: right;
          color: var(--primary-text-color, #212121);
        }
        .nmz-missing {
          grid-column: 3 / span 2;
          font-size: 10px;
          color: var(--secondary-text-color, #757575);
          text-align: right;
        }
        .nmz-actions {
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.07));
          display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        }
        .nmz-preview > .nmz-actions:first-of-type { margin-top: 6px; }
        .nmz-btn {
          font-size: 12px; font-weight: 600;
          padding: 5px 10px; border-radius: 6px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: transparent;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
        }
        .nmz-btn:hover { background: rgba(3, 169, 244, 0.08); }
        .nmz-btn.nmz-btn-save {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
        }
        .nmz-btn.nmz-btn-mownow {
          border-color: #fb8c00;
          color: #fb8c00;
        }
        .nmz-btn.nmz-btn-mownow:hover { background: rgba(251, 140, 0, 0.1); }
        .nmz-time-label {
          font-size: 11px;
          color: var(--secondary-text-color, #757575);
          display: flex; align-items: center; gap: 4px;
        }
        .nmz-time {
          font-size: 12px;
          padding: 2px 4px;
          border-radius: 4px;
          border: 1px solid var(--divider-color, rgba(0,0,0,0.2));
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
        }
        .nmz-status, .nmz-mownow-status {
          font-size: 11px;
          color: var(--secondary-text-color, #757575);
        }
        .nmz-preview-rows {
          margin-top: 6px;
        }
        .nmz-prev-row {
          display: grid;
          grid-template-columns: 76px 1fr;
          font-size: 12px;
          padding: 2px 0;
          column-gap: 8px;
        }
        .nmz-prev-date {
          font-weight: 600;
          color: var(--primary-text-color, #212121);
          white-space: nowrap;
        }
        .nmz-prev-zones {
          color: var(--primary-text-color, #212121);
        }
        .nmz-prev-zones em {
          color: var(--secondary-text-color, #757575);
          font-style: normal;
        }
      </style>
    `;

    this._els = {
      title: this.querySelector(".nmz-title"),
      rows: this.querySelector(".nmz-rows"),
      mowNowBtn: this.querySelector(".nmz-btn-mownow"),
      mowNowStatus: this.querySelector(".nmz-mownow-status"),
      previewBtn: this.querySelector(".nmz-btn-preview"),
      previewPanel: this.querySelector(".nmz-preview"),
      previewRows: this.querySelector(".nmz-preview-rows"),
      startInput: this.querySelector(".nmz-time-start"),
      endInput: this.querySelector(".nmz-time-end"),
      saveBtn: this.querySelector(".nmz-btn-save"),
      status: this.querySelector(".nmz-status"),
    };

    this._els.mowNowBtn.addEventListener("click", () => this._mowDueNow());
    this._els.previewBtn.addEventListener("click", () => {
      this._buildPreview();
      this._renderPreview();
    });
    this._els.startInput.addEventListener("change", (e) => {
      this._previewStart = e.target.value;
    });
    this._els.endInput.addEventListener("change", (e) => {
      this._previewEnd = e.target.value;
    });
    this._els.saveBtn.addEventListener("click", () => this._savePreview());
  }

  // --------------------------------------------------------------- lookup
  /** Find the "<zone> last completed" sensor and take only three things
   *  for granted: the mower (as a *device*, via the entity registry --
   *  see `_loadCompletionHistory`, which populates
   *  `_completionEntityIdsByZone`), the zone name, and the literal
   *  "last_completed" suffix Navimower bakes into these entity IDs (plus
   *  an optional `_2`/`_3` collision suffix). Nothing else -- no
   *  `zone_name` attribute check, no guessing a mower "prefix" out of
   *  this card's own `entity` config (that broke whenever the schedule
   *  sensor's slug picked up an unrelated word, e.g. "garten" from an
   *  area, that the completion sensors' own IDs never had). The first
   *  matching entity found (alphabetically) is used. */
  _findLastCompleted(zoneId, zoneName = null) {
    if (!this._hass || !this._config) return null;
    const states = this._hass.states;
    const wantedName = zoneName == null ? "" : String(zoneName).trim().toLocaleLowerCase();

    // An explicit override (set via the editor's "Advanced entity
    // overrides" panel) always wins over automatic discovery -- the user
    // picked it specifically because the automatic match was wrong or
    // unreliable for this zone.
    const overrideEntityId = this._overrideEntityId(wantedName);
    if (overrideEntityId) {
      const overrideState = states[overrideEntityId];
      if (overrideState && !["unknown", "unavailable", ""].includes(overrideState.state)) {
        return overrideState;
      }
      // The overridden entity has no usable live state (e.g. it's
      // disabled by default in the entity registry) -- fall back to its
      // own Recorder history rather than silently reverting to automatic
      // discovery, so the user's explicit choice is still honored.
      const historical = this._completionHistoryByEntity?.[overrideEntityId];
      if (historical) return historical;
    }

    if (!wantedName) return null;

    // Device-scoped candidate list, populated asynchronously once the
    // entity registry has loaded (see _loadCompletionHistory). Until
    // that first resolves, fall back to an unscoped (still
    // zone-slug-matched) scan of live states so the row doesn't just sit
    // at "never completed" for the first tick or two after the card
    // mounts.
    const scoped = this._completionEntityIdsByZone && this._completionEntityIdsByZone[wantedName];
    const candidates = scoped && scoped.length ? scoped : this._liveCompletionCandidates(zoneName);

    for (const eid of candidates) {
      const st = states[eid];
      if (st && !["unknown", "unavailable", ""].includes(st.state)) return st;
    }
    // None of the candidates currently have a live state -- fall back to
    // whichever one has Recorder history, in the same first-found order.
    for (const eid of candidates) {
      const historical = this._completionHistoryByEntity && this._completionHistoryByEntity[eid];
      if (historical) return historical;
    }
    return null;
  }

  /** Escape a slug for use inside a RegExp. */
  _escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Immediate, device-unaware fallback for `_findLastCompleted`: any
   *  live sensor entity whose ID ends in `_<zoneSlug>_last_completed`
   *  (optionally with a collision suffix). Used only until the
   *  device-scoped list from the entity registry has loaded. */
  _liveCompletionCandidates(zoneName) {
    const zoneSlug = this._slugifyZoneName(zoneName);
    if (!zoneSlug) return [];
    const pattern = new RegExp(`_${this._escapeRegExp(zoneSlug)}_last_completed(?:_\\d+)?$`);
    return Object.keys(this._hass.states)
      .filter((eid) => eid.startsWith("sensor.") && pattern.test(eid))
      .sort();
  }

  /** Look up a user-configured override for a (already normalized,
   *  lower-cased/trimmed) zone name. Returns the entity_id string, or
   *  null if no override is set for that zone. */
  _overrideEntityId(normalizedZoneName) {
    if (!normalizedZoneName) return null;
    const overrides = (this._config && this._config.entity_overrides) || {};
    const entityId = overrides[normalizedZoneName];
    return entityId ? String(entityId) : null;
  }

  _slugifyZoneName(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  /** Loads two things from Home Assistant's entity registry + Recorder,
   *  asynchronously (both need a WS round trip the synchronous render
   *  path doesn't have):
   *
   *  1. `_completionEntityIdsByZone`: for each zone, every completion
   *     sensor entity_id matched purely by device (same physical mower as
   *     this card's configured Schedule sensor) + the zone-name slug
   *     immediately preceding "_last_completed" in the entity ID. This is
   *     the device-scoped candidate list `_findLastCompleted` prefers.
   *  2. `_completionHistoryByEntity`: for every candidate entity (plus any
   *     configured overrides) that has *no current live state* (e.g.
   *     disabled by default in the registry), its newest Recorder row --
   *     so the row can still say "4 days ago" instead of "never
   *     completed" purely because the sensor happens to be disabled. */
  async _loadCompletionHistory(zones) {
    if (!this._hass || !this._config || !this._hass.callWS || !Array.isArray(zones)) return;
    const overrides = this._config.entity_overrides || {};
    const signature =
      zones.map((z) => `${z.id}:${z.name || ""}`).join("|") +
      "::" +
      Object.entries(overrides).map(([k, v]) => `${k}=${v}`).sort().join("|");
    if (signature === this._completionHistorySignature || this._completionHistoryLoading) return;
    this._completionHistoryLoading = true;

    try {
      const registry = await this._hass.callWS({ type: "config/entity_registry/list" });
      const entries = Array.isArray(registry && registry.entities) ? registry.entities : [];
      const scheduleEntry = entries.find((e) => e.entity_id === this._config.entity);
      const deviceId = scheduleEntry && scheduleEntry.device_id;

      // Purely device + zone-slug matched -- no zone_name attribute, no
      // original_name comparison. See _findLastCompleted's doc comment
      // for why (a schedule-entity-slug-derived "prefix" used to be part
      // of this and broke whenever that slug picked up an unrelated
      // word, e.g. an area name).
      const entityIdsByZone = {};
      for (const zone of zones) {
        const zoneSlug = this._slugifyZoneName(zone.name);
        if (!zoneSlug) continue;
        const pattern = new RegExp(`_${this._escapeRegExp(zoneSlug)}_last_completed(?:_\\d+)?$`);
        const matches = entries
          .filter((e) => {
            if (!e || !e.entity_id || !e.entity_id.startsWith("sensor.")) return false;
            if (!pattern.test(e.entity_id)) return false;
            if (deviceId && e.device_id && e.device_id !== deviceId) return false;
            return true;
          })
          .map((e) => e.entity_id)
          .sort();
        if (matches.length) entityIdsByZone[this._zoneKeyLocal(zone.name)] = matches;
      }
      this._completionEntityIdsByZone = entityIdsByZone;

      const overrideEntityIds = [...new Set(Object.values(overrides).filter(Boolean).map(String))];
      const entityIds = [
        ...new Set([...Object.values(entityIdsByZone).flat(), ...overrideEntityIds]),
      ];
      if (!entityIds.length) {
        this._completionHistorySignature = signature;
        this._render();
        return;
      }

      const start = new Date(Date.now() - 5 * 365 * 86400000).toISOString();
      const history = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start,
        entity_ids: entityIds,
        minimal_response: false,
        significant_changes_only: false,
      });

      const newestRow = (entityId) => {
        const rows = history && history[entityId];
        if (!Array.isArray(rows)) return null;
        let best = null;
        let bestTs = -Infinity;
        for (const row of rows) {
          const value = row && row.state;
          if (!value || ["unknown", "unavailable"].includes(value)) continue;
          const ts = Date.parse(row.last_changed || row.last_updated || value);
          if (!Number.isFinite(ts) || ts <= bestTs) continue;
          bestTs = ts;
          best = value;
        }
        return best;
      };

      this._completionHistoryByEntity = {};
      for (const entityId of entityIds) {
        const value = newestRow(entityId);
        if (value) {
          this._completionHistoryByEntity[entityId] = { entity_id: entityId, state: value, attributes: {} };
        }
      }

      this._completionHistorySignature = signature;
      this._render();
    } catch (err) {
      console.warn("navimow-zone-interval-card: could not load completion history", err);
    } finally {
      this._completionHistoryLoading = false;
    }
  }

  /** Same normalization `_overrideEntityId` keys are looked up by. */
  _zoneKeyLocal(name) {
    return String(name == null ? "" : name).trim().toLocaleLowerCase();
  }

  /** Find the "<zone> mow interval" number entity by its zone_id attribute,
   *  same matching strategy as _findLastCompleted above.
   *
   * Also consults a small local-override map: the moment a slider commits
   * a new value, that value is recorded here (see _render()'s "change"
   * listener) so the preview simulation reflects it immediately instead of
   * waiting for the round trip back from Home Assistant. Once the real
   * entity state catches up to the override, the override is dropped here
   * automatically -- it never permanently masks the real state, it just
   * bridges the gap until the real update arrives. */
  _findInterval(zoneId, zoneName = null, scheduleEntity = null) {
    if (!this._hass) return null;
    const states = this._hass.states;
    const candidates = [];

    for (const eid of Object.keys(states)) {
      if (!eid.startsWith("number.")) continue;
      const st = states[eid];
      const attrs = st.attributes || {};
      const hasIntervalName = eid.includes("mow_interval") ||
        String(st.name || attrs.friendly_name || "").toLowerCase().includes("mow interval");
      if (!hasIntervalName) continue;
      if (["unknown", "unavailable", ""].includes(st.state)) continue;

      const attrZoneName = attrs.zone_name != null ? String(attrs.zone_name) : "";
      const attrZoneId = attrs.zone_id != null ? Number(attrs.zone_id) : null;
      const attrSource = attrs.source_entity != null ? String(attrs.source_entity) : "";

      // Prefer the strongest association: this scheduler config + zone name.
      if (scheduleEntity && attrSource === scheduleEntity &&
          zoneName != null && attrZoneName === String(zoneName)) {
        return st;
      }
      candidates.push({ st, attrZoneName, attrZoneId, attrSource });
    }

    // Zone name is the stable semantic association used by the completion
    // sensors; use it before falling back to numeric zone_id.
    if (zoneName != null) {
      const wanted = String(zoneName);
      const byName = candidates.find(c => c.attrZoneName === wanted);
      if (byName) return byName.st;
    }

    const wantedId = Number(zoneId);
    const byId = candidates.find(c => c.attrZoneId !== null && c.attrZoneId === wantedId);
    return byId ? byId.st : null;
  }

  /** Age in *calendar* days, not rolling 24h windows. A completion at
   *  23:50 yesterday is "yesterday" even if checked 20 minutes later, and
   *  something from 47h59m ago is correctly "2 days ago" once midnight has
   *  passed twice -- counting raw elapsed hours gets both of those wrong. */
  _fmtAge(stateObj) {
    if (!stateObj || ["unknown", "unavailable", ""].includes(stateObj.state)) {
      return { text: "never completed", days: Infinity };
    }
    const d = new Date(stateObj.state);
    if (Number.isNaN(d.getTime())) return { text: "never completed", days: Infinity };
    const days = Math.round(
      (NavimowZoneIntervalCard._startOfDay(new Date()) - NavimowZoneIntervalCard._startOfDay(d)) /
        86400000
    );
    let text;
    if (days <= 0) text = "today";
    else if (days === 1) text = "yesterday";
    else text = `${days} days ago`;
    return { text, days };
  }

  _rowHtml(z) {
    const lm = this._findLastCompleted(z.id, z.name);
    const age = this._fmtAge(lm);
    const intervalState = this._findInterval(z.id, z.name, this._config.entity);
    const intervalDays = intervalState ? Number(intervalState.state) : 0;
    // Interval 0 = "not considered" -- never flagged overdue, matching how
    // the schedule preview/save/mow-now also skip these zones entirely.
    const overdue = intervalDays > 0 && age.days >= intervalDays;
    const isZero = !!intervalState && intervalDays === 0;
    let sliderHtml;
    if (intervalState) {
      const value = Number(intervalState.state);
      const attrs = intervalState.attributes || {};
      const min = attrs.min !== undefined ? Number(attrs.min) : 1;
      const max = attrs.max !== undefined ? Number(attrs.max) : 30;
      const step = attrs.step !== undefined ? Number(attrs.step) : 1;
      sliderHtml =
        `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" ` +
        `data-entity="${intervalState.entity_id}" data-zone-id="${z.id}" class="nmz-slider" />` +
        `<span class="nmz-value">${value}d</span>`;
    } else {
      sliderHtml = `<span class="nmz-missing">no mow-interval entity for this zone yet</span>`;
    }
    return (
      `<div class="nmz-row">` +
      `<div class="nmz-name${overdue ? " nmz-overdue" : ""}${isZero ? " nmz-zero" : ""}">${z.name || `Zone ${z.id}`}</div>` +
      `<div class="nmz-age">${age.text}</div>` +
      `<div class="nmz-slider-wrap">${sliderHtml}</div>` +
      `</div>`
    );
  }

  // ------------------------------------------------------------ schedule preview
  static WEEKDAY_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  static _startOfDay(dt) {
    const x = new Date(dt);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** Compute today's eligible/due zones -- shared by _buildPreview() (which
   *  continues the same nextDue map forward into the 7-day projection) and
   *  the standalone Mow-now button (which only needs today's list and
   *  shouldn't require the 7-day preview to have ever been opened). */
  _computeDueToday() {
    const stateObj = this._hass.states[this._config.entity];
    const zones = (stateObj && stateObj.attributes && stateObj.attributes.zones) || [];
    const today = NavimowZoneIntervalCard._startOfDay(new Date());

    const eligible = [];
    const nextDue = {};
    const nameById = {};
    const lastCompletedDate = {};

    zones.forEach((z) => {
      const intervalState = this._findInterval(z.id, z.name, this._config.entity);
      const intervalDays = intervalState ? Number(intervalState.state) : 0;
      if (!(intervalDays > 0)) return; // interval 0 (or missing) -> not considered
      const lm = this._findLastCompleted(z.id, z.name);
      let base = null;
      if (lm && !["unknown", "unavailable", ""].includes(lm.state)) {
        const d = new Date(lm.state);
        if (!Number.isNaN(d.getTime())) base = NavimowZoneIntervalCard._startOfDay(d);
      }
      nextDue[z.id] = base
        ? new Date(base.getTime() + intervalDays * 86400000)
        : today; // never completed -> due today
      lastCompletedDate[z.id] = base; // null if never completed
      nameById[z.id] = z.name || `Zone ${z.id}`;
      eligible.push({ id: z.id, intervalDays });
    });

    const dueToday = eligible.filter((z) => nextDue[z.id] <= today).map((z) => z.id);
    return { today, eligible, nextDue, nameById, dueToday, lastCompletedDate };
  }

  /** Simulate which zones would be due on each of the *following* 7 days
   *  (tomorrow .. +7), building on _computeDueToday()'s result.
   *
   * Zones with interval 0 are excluded entirely (never scheduled from
   * here). A zone with no completion history yet is due immediately.
   * A zone that's due today is only treated as "handled" (its next
   * projected due date advanced by its own interval) if it has *actually*
   * been completed today -- not just assumed, since the Mow-now button
   * might not have been pressed yet, might fail, or the mower might get
   * rained out. A zone that's due but not yet completed today stays due,
   * so it naturally carries into tomorrow's projection too as a safety
   * net -- matching save_due_schedule's backend simulation exactly, so
   * the card's preview and what an automation actually saves always
   * agree.
   */
  _buildPreview() {
    const { today, eligible, nextDue, nameById, dueToday, lastCompletedDate } =
      this._computeDueToday();

    dueToday.forEach((zid) => {
      const completedToday =
        lastCompletedDate[zid] && lastCompletedDate[zid].getTime() === today.getTime();
      if (completedToday) {
        const z = eligible.find((e) => e.id === zid);
        nextDue[zid] = new Date(today.getTime() + z.intervalDays * 86400000);
      }
      // else: leave nextDue[zid] as-is (<= today) -- it rolls forward and
      // shows up starting with tomorrow's projection too.
    });

    const days = [];
    for (let i = 1; i <= 7; i++) {
      const date = new Date(today.getTime() + i * 86400000);
      const dueIds = eligible.filter((z) => nextDue[z.id] <= date).map((z) => z.id);
      days.push({ date, zoneIds: dueIds });
      dueIds.forEach((zid) => {
        const z = eligible.find((e) => e.id === zid);
        nextDue[zid] = new Date(date.getTime() + z.intervalDays * 86400000);
      });
    }

    this._previewDays = days;
    this._previewZoneNames = nameById;
    this._previewStatus = "";
    // Editable copies so adjusting the time range in the preview doesn't
    // require re-opening the card config -- only seeded on a fresh
    // "Preview" click, not overwritten on every hass update, so the user's
    // edits stick while they're deciding.
    if (this._previewStart === undefined) this._previewStart = this._config.start;
    if (this._previewEnd === undefined) this._previewEnd = this._config.end;
  }

  async _savePreview() {
    if (!this._config.device_id) {
      this._previewStatus =
        "Set 'device_id' in the card config first (Settings \u2192 Devices \u2192 open the mower \u2192 copy its ID).";
      this._renderPreview();
      return;
    }
    // Always recompute right before saving -- the on-screen preview can go
    // stale if the panel's been left open while a zone got mowed via the
    // app, a slider got dragged elsewhere, etc. This guarantees what gets
    // saved (and what the confirm dialog below lists) reflects the current
    // entity states, not whatever was true whenever "Preview" was last
    // clicked. _buildPreview() preserves any start/end time the user has
    // already edited in the panel (see its "only seeded on a fresh..."
    // comment), so this doesn't clobber that.
    this._buildPreview();
    this._renderPreview();

    const daysWithZones = (this._previewDays || []).filter((d) => d.zoneIds.length > 0);
    if (!daysWithZones.length) {
      this._previewStatus = "Nothing to save \u2014 no zone is due in the next 7 days.";
      this._renderPreview();
      return;
    }
    const weekdays = daysWithZones.map((d) => NavimowZoneIntervalCard.WEEKDAY_EN[d.date.getDay()]);
    const start = this._previewStart || this._config.start;
    const end = this._previewEnd || this._config.end;
    const confirmed = window.confirm(
      `This overwrites the schedule for: ${weekdays.join(", ")} (${start}\u2013${end}).\n` +
        `Days not listed here (nothing due) are left untouched. Continue?`
    );
    if (!confirmed) return;

    this._previewStatus = "Saving\u2026";
    this._renderPreview();
    try {
      for (const day of daysWithZones) {
        await this._hass.callService("navimower", "set_schedule", {
          device_id: this._config.device_id,
          day: NavimowZoneIntervalCard.WEEKDAY_EN[day.date.getDay()],
          enabled: true,
          periods: [{ start, end, zones: day.zoneIds }],
        });
      }
      this._previewStatus = `Saved ${daysWithZones.length} day(s) to the mower.`;
    } catch (err) {
      this._previewStatus = `Failed: ${(err && err.message) || err}`;
    }
    this._renderPreview();
  }

  async _mowDueNow() {
    if (!this._config.device_id) {
      this._els.mowNowStatus.textContent =
        "Set 'device_id' in the card config first (Settings \u2192 Devices \u2192 open the mower \u2192 copy its ID).";
      return;
    }
    const { dueToday, nameById } = this._computeDueToday();
    if (!dueToday.length) {
      this._els.mowNowStatus.textContent = "Nothing due today.";
      return;
    }
    const names = dueToday.map((id) => nameById[id]).join(", ");
    const confirmed = window.confirm(`Start mowing now: ${names}?`);
    if (!confirmed) return;

    this._els.mowNowStatus.textContent = "Starting\u2026";
    try {
      await this._hass.callService("navimower", "mow", {
        device_id: this._config.device_id,
        zones: dueToday,
        reset: false,
      });
      this._els.mowNowStatus.textContent = `Mowing started: ${names}.`;
    } catch (err) {
      this._els.mowNowStatus.textContent = `Failed: ${(err && err.message) || err}`;
    }
    // "Due today" fed into day 1's carry-forward assumption in the 7-day
    // preview -- refresh it too, if it's currently open.
    if (this._previewDays) {
      this._buildPreview();
      this._renderPreview();
    }
  }

  // --------------------------------------------------------------- render
  /** Updates the zone-rows section only. Rebuilds that container's
   *  innerHTML (rows themselves have no persistent state worth preserving
   *  beyond the slider drag, guarded below) but never touches the preview
   *  panel's permanent nodes -- see _renderPreview(). */
  _render() {
    if (!this._hass || !this._config || !this._els) return;

    this._els.title.textContent = this._config.title || "";
    this._els.title.style.display = this._config.title ? "" : "none";

    const stateObj = this._hass.states[this._config.entity];
    if (!stateObj) {
      this._els.rows.innerHTML = `<div class="nmz-empty">Entity ${this._config.entity} not found.</div>`;
      this._renderPreview();
      return;
    }
    const zones = (stateObj.attributes && stateObj.attributes.zones) || [];
    if (!zones.length) {
      this._els.rows.innerHTML = `<div class="nmz-empty">No zones on ${this._config.entity} yet.</div>`;
      this._renderPreview();
      return;
    }

    // Some Navimow completion entities can remain in Recorder/entity-registry
    // history after the live entity is disabled/removed (for example after a
    // zone was recreated). Load those historical timestamps asynchronously so
    // the row can still say "today"/"4 days ago" instead of "never completed".
    this._loadCompletionHistory(zones);

    // Don't rip a slider out from under an in-progress drag.
    const active = document.activeElement;
    const rowsFocused = active && this._els.rows.contains(active) && active.tagName === "INPUT";
    if (!rowsFocused) {
      this._els.rows.innerHTML = zones.map((z) => this._rowHtml(z)).join("");
      this._els.rows.querySelectorAll(".nmz-slider").forEach((el) => {
        // Live-update the number label while dragging, without hammering
        // the service call on every pixel of drag.
        el.addEventListener("input", (e) => {
          const wrap = e.target.closest(".nmz-slider-wrap");
          const label = wrap && wrap.querySelector(".nmz-value");
          if (label) label.textContent = `${e.target.value}d`;
        });
        // Commit to Home Assistant only once the drag/click is released.
        el.addEventListener("change", (e) => {
          const entity = e.target.getAttribute("data-entity");
          const zoneId = e.target.getAttribute("data-zone-id");
          const value = Number(e.target.value);
          this._hass.callService("number", "set_value", { entity_id: entity, value });
          // Bridge the gap until hass reflects the new value (see
          // _findInterval's override handling), then refresh the 7-day
          // preview immediately if it's open, rather than leaving it
          // showing a schedule computed from the old interval.
          if (zoneId) {
            this._localOverrides = this._localOverrides || {};
            this._localOverrides[zoneId] = value;
          }
          if (this._previewDays) {
            this._buildPreview();
            this._renderPreview();
          }
        });
      });
    }

    this._renderPreview();
  }

  /** Updates the preview panel: visibility, the (plain, non-focusable) day
   *  rows, and the status line -- all safe to blow away and rebuild on
   *  every call. The two time <input> nodes are never recreated (they're
   *  built once in _build()); only their .value is set, and only when
   *  they don't currently have focus, so a value is never overwritten
   *  mid-edit. */
  _renderPreview() {
    if (!this._els) return;
    if (!this._previewDays) {
      this._els.previewPanel.hidden = true;
      return;
    }
    this._els.previewPanel.hidden = false;

    const fmtDate = (d) =>
      d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "2-digit" });
    this._els.previewRows.innerHTML = this._previewDays
      .map((day) => {
        const names = day.zoneIds.map((id) => this._previewZoneNames[id]).join(", ");
        return (
          `<div class="nmz-prev-row">` +
          `<span class="nmz-prev-date">${fmtDate(day.date)}</span>` +
          `<span class="nmz-prev-zones">${names || "<em>none due</em>"}</span>` +
          `</div>`
        );
      })
      .join("");

    if (document.activeElement !== this._els.startInput) {
      this._els.startInput.value = this._previewStart;
    }
    if (document.activeElement !== this._els.endInput) {
      this._els.endInput.value = this._previewEnd;
    }
    this._els.status.textContent = this._previewStatus || "";
  }
}

customElements.define("navimow-zone-interval-card", NavimowZoneIntervalCard);

/** Minimal ha-form based visual editor.
 *
 * In addition to the static fields (entity/title/device_id/start/end),
 * this builds one extra, *dynamic* schema entry per zone found on the
 * currently configured Schedule sensor, nested inside a collapsible
 * "Advanced entity overrides" expansion panel (HA's built-in `expandable`
 * form-schema type -- collapsed by default, so it stays out of the way
 * unless someone actually needs it). Each field is an entity picker that
 * lets the user pin a specific "last completed" sensor for that zone,
 * overriding the card's automatic mower-prefix + zone_name discovery
 * (see `_findLastCompleted` / `_overrideEntityId` on the card class
 * above) -- useful when that automatic match is ambiguous or wrong for a
 * particular zone, without having to hand-edit YAML.
 *
 * The panel's data lands in `config.entity_overrides`, keyed by each
 * zone's name (trimmed, lower-cased -- see `_zoneKey`), matching exactly
 * how the card's own `_overrideEntityId` looks the value up.
 */
class NavimowZoneIntervalCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._form) return;
    this._form.hass = hass;
    // Re-derive the per-zone override schema when the set of zones on the
    // configured Schedule sensor actually changes (new mower selected, a
    // zone added/removed/renamed on the mower) -- not on every single
    // hass push, which would otherwise reassign `.schema` every few
    // seconds while a mower is active and risk disrupting an in-progress
    // entity-picker interaction.
    const signature = this._zoneSignature();
    if (signature !== this._lastZoneSignature) {
      this._lastZoneSignature = signature;
      this._form.schema = this._computeSchema();
    }
  }

  connectedCallback() {
    this._render();
  }

  _zones() {
    const entity = this._config && this._config.entity;
    const stateObj = entity && this._hass && this._hass.states[entity];
    const zones = (stateObj && stateObj.attributes && stateObj.attributes.zones) || [];
    return zones.filter((z) => z && z.name);
  }

  _zoneSignature() {
    return this._zones().map((z) => z.name).join("|");
  }

  _zoneKey(name) {
    return String(name == null ? "" : name).trim().toLocaleLowerCase();
  }

  /** Best-effort preview of what the card would auto-detect for a zone
   *  right now, shown as helper text so the user can judge whether an
   *  override is actually necessary. Mirrors the card's own fallback
   *  live-state scan (zone-slug + "_last_completed" suffix, first match
   *  alphabetically) -- the editor has no cheap way to also scope by
   *  device the way the card does once its registry fetch resolves, so
   *  this is intentionally just a hint, not authoritative. */
  _autoDetectedEntityId(zoneName) {
    if (!this._hass) return null;
    const zoneSlug = String(zoneName == null ? "" : zoneName)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!zoneSlug) return null;
    const escaped = zoneSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`_${escaped}_last_completed(?:_\\d+)?$`);
    const states = this._hass.states;
    const matches = Object.keys(states)
      .filter((eid) => eid.startsWith("sensor.") && pattern.test(eid))
      .sort();
    return matches[0] || null;
  }

  _computeSchema() {
    const zones = this._zones();
    this._zoneLabelByKey = {};
    const overrideSchema = zones.map((z) => {
      const key = this._zoneKey(z.name);
      this._zoneLabelByKey[key] = z.name;
      return { name: key, selector: { entity: { domain: "sensor" } } };
    });

    const schema = [...NavimowZoneIntervalCardEditor.BASE_SCHEMA];
    if (overrideSchema.length) {
      schema.push({
        name: "entity_overrides",
        type: "expandable",
        title: "Advanced entity overrides",
        icon: "mdi:tune",
        schema: overrideSchema,
      });
    }
    return schema;
  }

  _computeLabel(schema) {
    if (schema.name === "entity_overrides") return "Advanced entity overrides";
    if (this._zoneLabelByKey && Object.prototype.hasOwnProperty.call(this._zoneLabelByKey, schema.name)) {
      return `${this._zoneLabelByKey[schema.name]} \u2013 last completed sensor`;
    }
    return NavimowZoneIntervalCardEditor.LABELS[schema.name] || schema.name;
  }

  _computeHelper(schema) {
    if (schema.name === "entity_overrides") {
      return (
        "Only needed if a zone's automatically matched \u201clast completed\u201d sensor " +
        "is missing or unreliable. Leave a zone blank to keep automatic discovery."
      );
    }
    if (this._zoneLabelByKey && Object.prototype.hasOwnProperty.call(this._zoneLabelByKey, schema.name)) {
      const auto = this._autoDetectedEntityId(this._zoneLabelByKey[schema.name]);
      return auto ? `Auto-detected: ${auto}` : "No sensor auto-detected for this zone yet.";
    }
    return undefined;
  }

  /** Drop empty/cleared override entries so config stays tidy instead of
   *  accumulating `{"birnbaum": ""}` clutter, and drop the whole
   *  `entity_overrides` key once nothing is left in it. */
  _pruneEmptyOverrides(config) {
    if (!config || !config.entity_overrides) return config;
    const cleaned = {};
    for (const [key, value] of Object.entries(config.entity_overrides)) {
      if (value) cleaned[key] = value;
    }
    const next = { ...config };
    if (Object.keys(cleaned).length) {
      next.entity_overrides = cleaned;
    } else {
      delete next.entity_overrides;
    }
    return next;
  }

  _render() {
    if (!this.isConnected) return;
    if (!this._form) {
      this.innerHTML = `<ha-form></ha-form>`;
      this._form = this.querySelector("ha-form");
      this._form.computeLabel = (schema) => this._computeLabel(schema);
      this._form.computeHelper = (schema) => this._computeHelper(schema);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = this._pruneEmptyOverrides(ev.detail.value);
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
        );
      });
    }
    if (this._hass) this._form.hass = this._hass;
    this._form.data = this._config;
    this._lastZoneSignature = this._zoneSignature();
    this._form.schema = this._computeSchema();
  }
}

NavimowZoneIntervalCardEditor.BASE_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "title", selector: { text: {} } },
  { name: "device_id", selector: { device: { integration: "navimower" } } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "start", selector: { text: {} } },
      { name: "end", selector: { text: {} } },
    ],
  },
];

NavimowZoneIntervalCardEditor.LABELS = {
  entity: "Mower Schedule sensor (sensor.xxx_schedule)",
  title: "Card title",
  device_id: "Mower device (needed to save the schedule)",
  start: "Preview window start (HH:MM)",
  end: "Preview window end (HH:MM)",
};

customElements.define("navimow-zone-interval-card-editor", NavimowZoneIntervalCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "navimow-zone-interval-card",
  name: "Navimow Zone Mow Interval",
  description: `Per-zone slider for desired mow interval, last-completed status, a standalone Mow-now button, and a 7-day (from tomorrow) schedule preview/save -- all refreshing instantly on change. (v${CARD_VERSION})`,
});
