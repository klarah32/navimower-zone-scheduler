/**
 * navimow-zone-interval-card
 *
 * One row per zone: a checkbox that includes/excludes the zone from
 * scheduling altogether -- deselecting it greys out the whole row and
 * disables its interval slider, since the interval is meaningless while
 * the zone isn't being scheduled -- the zone name (highlighted green when
 * today's `get_due_zones` result says this zone is overdue), how long ago
 * it was last fully completed (full-coverage finish, not just any mowing
 * activity, measured in calendar days -- "yesterday" means the calendar
 * day before today, not "less than 48 rolling hours ago"), and a slider
 * for the desired mow interval (1-7 days) -- the interval/enabled entities
 * are read directly (matched by each entity's own `zone_id` attribute,
 * never by guessing an entity_id from the zone's name, so renaming a zone
 * in the app never breaks the match) since those are just this card
 * editing this zone's own settings, not a due-zone decision.
 *
 * Which zones actually count as "due" -- the row highlight, the Mow-now
 * confirm dialog, and the 7-day preview table -- is deliberately NOT
 * computed here anymore. It's asked of the backend
 * (`navimower_zone_scheduler.get_due_zones` / `preview_due_schedule`),
 * the exact same calculation `mow_due_zones` / `save_due_schedule` use to
 * decide what to actually do. There is only one implementation of "which
 * zones are due", on the backend; this card is a thin client over it, so
 * it can never show/act on a different list than an automation calling
 * those services would.
 *
 * Right below the zone rows, a standalone "Mow due zones now" button
 * calls `navimower_zone_scheduler.mow_due_zones` directly (after first
 * calling the read-only `get_due_zones` to populate the confirm dialog
 * with the zone names) -- it does NOT require opening the 7-day preview
 * first.
 *
 * A "Preview next 7 days" button calls the read-only
 * `navimower_zone_scheduler.preview_due_schedule` service to show which
 * zones would be due each of the *next* 7 days -- starting tomorrow, not
 * today, since writing a recurring schedule slot for "today" is
 * pointless once part of the day may already have elapsed (that's what
 * the Mow-now button above is for). "Save to mower" re-fetches that same
 * preview immediately before saving -- so a panel left open for a while
 * (a zone finished via the app, a slider dragged on another device, etc.)
 * can't save a stale schedule -- then calls
 * `navimower_zone_scheduler.save_due_schedule` once, which itself writes
 * only the days that actually have zones due, after a confirmation step
 * listing exactly which weekdays will be overwritten.
 *
 * The preview auto-refreshes the instant you drag a zone's interval
 * slider, toggle its enabled switch, or use Mow-now -- but only as a
 * fresh call to `preview_due_schedule`, not a local recomputation, so it
 * always reflects what the backend would actually save.
 *
 * No manual helper creation needed: a brand-new zone gets its interval
 * entity (defaulting to 1 day) and its enabled switch (defaulting to off)
 * automatically as soon as the integration sees it, exactly like its
 * "last completed" sensor. If a zone somehow has no interval entity yet,
 * its row shows a note instead of a slider so nothing is silently skipped.
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
 *
 * "last completed", per zone, is read directly from this integration's own
 * `sensor.*_last_completed` entities (see sensor.py's
 * ZoneLastCompletedSensor) -- matched the same synchronous, zero-WS-call
 * way as the interval/enabled entities, via each entity's own
 * `zone_id`/`zone_name`/`source_entity` attributes. This is purely
 * informational display (the "X days ago" text on a row); it never feeds
 * into a due-zone decision. If a zone's automatically matched sensor is
 * ever wrong (rare -- see select.py), fix it once, centrally, on that
 * zone's "completion source" select entity -- that fix reaches every
 * card/dashboard and the backend services alike, since there's no
 * separate per-card override to fall out of sync with it anymore.
 */

// The integration serves this card with a `?v=<manifest version>` query
// string on its <script type="module"> URL (see _async_register_card() in
// __init__.py) purely so the version shown below is always read from
// manifest.json, the single source of truth -- never hand-edited here and
// never able to drift out of sync with the installed integration version
// the way the old hardcoded CARD_VERSION constant could (and had).
// `document.currentScript` doesn't work for module scripts, so this uses
// `import.meta.url`, which is the standard way to read a module's own
// script URL (including its query string) from inside itself.
const CARD_VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "dev";
  } catch (err) {
    return "dev";
  }
})();

/** The real implementation, lazily loaded by the tiny shim in
 *  navimow-zone-interval-card.js (see that file's header comment for why
 *  the split exists). Deliberately NOT a custom element itself -- a class
 *  that extends HTMLElement can only ever be instantiated via
 *  `customElements.define()` + `document.createElement()`/parsing, never
 *  via a plain `new`, so making this a normal class that takes the
 *  shim's own element as a "host" to render into lets the shim create it
 *  on demand (once this module has finished loading) without a second
 *  custom-element registration. Every place the original single-file
 *  version touched the DOM via `this` now goes through `this._host`
 *  instead; everything else (state, config, timers) is unchanged. */
class NavimowZoneIntervalCardImpl {
  constructor(host) {
    this._host = host;
  }

  setConfig(config) {
    try {
      if (!config.entity) {
        throw new Error(
          "please set 'entity' to a mower's Schedule sensor (sensor.xxx_schedule)"
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
    } catch (err) {
      // A thrown error here (or from hass setter below) makes Lovelace
      // permanently swap this element for its own red "Configuration
      // error" card -- and it then stops calling setConfig/hass on this
      // instance entirely, so even a purely transient hiccup (entity not
      // loaded yet, a flaky mobile connection, a registry call that
      // hasn't resolved yet) leaves the card stuck broken until the whole
      // dashboard is reloaded. Handling it ourselves instead means the
      // card keeps receiving hass updates and can self-heal the moment
      // the underlying condition clears.
      this._showError(err, "config");
    }
  }

  set hass(hass) {
    this._hass = hass;
    try {
      // If a previous error wiped the built DOM (see _showError), rebuild
      // it before rendering -- otherwise this and every future call would
      // silently no-op against the old, no-longer-attached elements once
      // _render()'s `!this._els` guard exists to protect it.
      if (this._config && !this._built) this._build();
      this._render();
    } catch (err) {
      this._showError(err, "render");
    }
  }

  // Renders a small, self-contained error message in place of the normal
  // card body. Doesn't depend on this._els / this._build() having run,
  // since setConfig can fail before either of those happen.
  _showError(err, context) {
    const message = (err && err.message) || String(err);
    console.error(`navimow-zone-interval-card: ${context} error`, err);
    // Both cleared so the next successful hass/setConfig call rebuilds
    // fresh DOM instead of _render() silently writing into (or bailing
    // out on) the old elements this just replaced.
    this._built = false;
    this._els = null;
    this._host.innerHTML = `
      <ha-card>
        <div class="nmz-error">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          <div>
            <div class="nmz-error-title">navimow-zone-interval-card</div>
            <div class="nmz-error-msg"></div>
          </div>
        </div>
      </ha-card>
      <style>
        .nmz-error { display:flex; gap:10px; align-items:flex-start; padding:12px 14px; color: var(--error-color, #db4437); }
        .nmz-error ha-icon { flex: none; margin-top:1px; }
        .nmz-error-title { font-size:13px; font-weight:600; }
        .nmz-error-msg { font-size:12px; opacity:0.85; margin-top:2px; word-break:break-word; }
      </style>
    `;
    // textContent, not innerHTML, so the error message itself can never
    // be interpreted as markup.
    this._host.querySelector(".nmz-error-msg").textContent = message;
  }

  getCardSize() {
    const zones =
      this._hass &&
      this._hass.states[this._config && this._config.entity] &&
      this._hass.states[this._config.entity].attributes.zones;
    return 1 + Math.max(1, (zones || []).length) * 0.6;
  }

  // getConfigElement()/getStubConfig() live on the shim now (see
  // navimow-zone-interval-card.js) -- Lovelace calls those as static
  // methods on the *registered custom element class*, which is the shim,
  // not this impl class, so duplicating them here would just be dead code.

  // ---------------------------------------------------------------- build
  /** Builds the entire DOM exactly once. Every element that can hold user
   *  focus (the time inputs, and via delegation the per-zone sliders) is
   *  created here and never recreated -- later updates only ever touch an
   *  existing node's .value/.textContent/.hidden, so nothing can steal
   *  focus out of a field the user is actively editing. */
  _build() {
    this._built = true;
    this._host.innerHTML = `
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
          grid-template-columns: 20px minmax(0, 1fr) auto 90px 24px;
          align-items: center;
          column-gap: 8px;
          padding: 3px 0;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.07));
        }
        .nmz-row:first-of-type { border-top: none; }
        .nmz-row.nmz-row-off {
          opacity: 0.5;
        }
        .nmz-enable {
          width: 16px;
          height: 16px;
          margin: 0;
          accent-color: var(--primary-color, #03a9f4);
        }
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
        .nmz-name.nmz-disabled {
          font-style: italic;
        }
        .nmz-age {
          font-size: 11px;
          color: var(--secondary-text-color, #757575);
          white-space: nowrap;
        }
        .nmz-age-clickable {
          cursor: pointer;
          text-decoration: underline dotted;
          text-underline-offset: 2px;
        }
        .nmz-age-clickable:hover {
          color: var(--primary-color, #03a9f4);
        }
        .nmz-manual {
          font-style: italic;
          opacity: 0.8;
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
        .nmz-slider:disabled {
          cursor: not-allowed;
        }
        .nmz-value {
          font-size: 11px; font-weight: 600; text-align: right;
          color: var(--primary-text-color, #212121);
        }
        .nmz-missing {
          grid-column: 4 / span 2;
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
          grid-template-columns: 88px 1fr;
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
      title: this._host.querySelector(".nmz-title"),
      rows: this._host.querySelector(".nmz-rows"),
      mowNowBtn: this._host.querySelector(".nmz-btn-mownow"),
      mowNowStatus: this._host.querySelector(".nmz-mownow-status"),
      previewBtn: this._host.querySelector(".nmz-btn-preview"),
      previewPanel: this._host.querySelector(".nmz-preview"),
      previewRows: this._host.querySelector(".nmz-preview-rows"),
      startInput: this._host.querySelector(".nmz-time-start"),
      endInput: this._host.querySelector(".nmz-time-end"),
      saveBtn: this._host.querySelector(".nmz-btn-save"),
      status: this._host.querySelector(".nmz-status"),
    };

    this._els.mowNowBtn.addEventListener("click", () => this._mowDueNow());
    this._els.previewBtn.addEventListener("click", async () => {
      await this._buildPreview();
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
  /** Find this zone's "last completed" sensor -- one of this integration's
   *  own `sensor.*_last_completed` entities (see sensor.py's
   *  ZoneLastCompletedSensor / select.py's ZoneCompletionSourceSelect on
   *  the backend), matched the same synchronous, no-WS-call way
   *  `_findInterval`/`_findEnabled` below already match their own
   *  per-zone entities: by the `zone_id`/`zone_name`/`source_entity`
   *  attributes the entity itself publishes, never by re-deriving
   *  anything from Navimower's raw entity IDs here. The backend entity
   *  already did that device+zone-slug matching (and any Recorder
   *  fallback for a disabled-by-default source) once, server-side, with
   *  normal logging instead of a silent client-side dead end -- see
   *  `_completion_entity_ids_for_zone` in service.py.
   *
   *  This is purely informational (the "last completed X days ago" text
   *  on a row) -- it never feeds into which zones are treated as due;
   *  that decision now always comes from the backend's due-zone/preview
   *  services, so there is exactly one place a "wrong" match could
   *  affect: this display. Fix it once, centrally, on that zone's
   *  "completion source" select entity (select.py) rather than in this
   *  card -- that fix reaches every card and the backend alike. */
  _findCompletedRaw(zoneId, zoneName = null, scheduleEntity = null) {
    if (!this._hass) return null;
    const states = this._hass.states;

    const candidates = [];
    for (const eid of Object.keys(states)) {
      if (!eid.startsWith("sensor.")) continue;
      const st = states[eid];
      const attrs = st.attributes || {};
      const hasCompletedName = eid.includes("last_completed") ||
        String(st.name || attrs.friendly_name || "").toLowerCase().includes("last completed");
      if (!hasCompletedName) continue;
      if (["unknown", "unavailable", ""].includes(st.state)) continue;

      const attrZoneName = attrs.zone_name != null ? String(attrs.zone_name) : "";
      const attrZoneId = attrs.zone_id != null ? Number(attrs.zone_id) : null;
      const attrSource = attrs.source_entity != null ? String(attrs.source_entity) : "";

      // Two mowers can have same-named (or same-id) zones -- e.g. both
      // have a "Birnbaum" zone -- so once a schedule entity is known,
      // every candidate below must belong to *this* mower before it's
      // even eligible for the name/id fallback. Skipping this scoping
      // would let a name/id match silently pick the wrong mower's entity.
      if (scheduleEntity && attrSource !== scheduleEntity) continue;

      // Prefer the strongest association: this scheduler config + zone name.
      if (scheduleEntity && zoneName != null && attrZoneName === String(zoneName)) {
        return st;
      }
      candidates.push({ st, attrZoneName, attrZoneId });
    }

    // Zone name is the stable semantic association; fall back to numeric
    // zone_id only if nothing matched by name. `candidates` is already
    // scoped to this mower's schedule entity above.
    if (zoneName != null) {
      const wanted = String(zoneName);
      const byName = candidates.find((c) => c.attrZoneName === wanted);
      if (byName) return byName.st;
    }

    const wantedId = Number(zoneId);
    const byId = candidates.find((c) => c.attrZoneId !== null && c.attrZoneId === wantedId);
    return byId ? byId.st : null;
  }

  /** Like _findEnabled/_findInterval: wraps `_findCompletedRaw` with a
   *  small local-override bridge. The moment "mark completed now" is
   *  clicked on a row (see _render()'s click listener on `.nmz-age-clickable`),
   *  that action's timestamp is recorded here so the row immediately shows
   *  "today" instead of waiting for the button press -> backend floor
   *  write -> state round trip to land. Once the real completion sensor
   *  catches up to (or overtakes) the override, the override is dropped
   *  automatically -- same bridging discipline as the enabled/interval
   *  overrides, it never permanently masks the real state. */
  _findCompleted(zoneId, zoneName = null, scheduleEntity = null) {
    const st = this._findCompletedRaw(zoneId, zoneName, scheduleEntity);
    const override = this._localCompletedOverrides && this._localCompletedOverrides[zoneId];
    if (override === undefined) return st;

    const overrideMs = Number(override);
    const realMs =
      st && !["unknown", "unavailable", ""].includes(st.state) ? Date.parse(st.state) : NaN;
    if (Number.isFinite(realMs) && realMs >= overrideMs) {
      delete this._localCompletedOverrides[zoneId];
      return st;
    }
    return {
      entity_id: (st && st.entity_id) || null,
      state: new Date(overrideMs).toISOString(),
      attributes: { ...((st && st.attributes) || {}), manual: true },
    };
  }

  /** Find the "<zone> mark completed now" button entity by its zone_id
   *  attribute, same matching strategy as _findInterval/_findCompletedRaw
   *  above. Returns null if the zone has no such button yet (e.g. an
   *  install that hasn't picked up the button.py platform) -- the row's
   *  age text simply isn't made clickable in that case. */
  _findMarkCompletedButton(zoneId, zoneName = null, scheduleEntity = null) {
    if (!this._hass) return null;
    const states = this._hass.states;
    const candidates = [];

    for (const eid of Object.keys(states)) {
      if (!eid.startsWith("button.")) continue;
      const st = states[eid];
      const attrs = st.attributes || {};
      const hasMarkName = eid.includes("mark_completed") ||
        String(st.name || attrs.friendly_name || "").toLowerCase().includes("mark completed");
      if (!hasMarkName) continue;

      const attrZoneName = attrs.zone_name != null ? String(attrs.zone_name) : "";
      const attrZoneId = attrs.zone_id != null ? Number(attrs.zone_id) : null;
      const attrSource = attrs.source_entity != null ? String(attrs.source_entity) : "";

      // Same cross-mower scoping as _findCompletedRaw above -- two mowers
      // can share a zone name (or numeric id).
      if (scheduleEntity && attrSource !== scheduleEntity) continue;

      if (scheduleEntity && zoneName != null && attrZoneName === String(zoneName)) {
        return st;
      }
      candidates.push({ st, attrZoneName, attrZoneId });
    }

    if (zoneName != null) {
      const wanted = String(zoneName);
      const byName = candidates.find((c) => c.attrZoneName === wanted);
      if (byName) return byName.st;
    }

    const wantedId = Number(zoneId);
    const byId = candidates.find((c) => c.attrZoneId !== null && c.attrZoneId === wantedId);
    return byId ? byId.st : null;
  }

  /** Escape a value for safe use inside a double-quoted HTML attribute. */
  _escapeHtmlAttr(value) {
    return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  /** Find the "<zone> mow interval" number entity by its zone_id attribute,
   *  same matching strategy as _findCompleted above.
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

      // Two mowers can share a zone name (or numeric id) -- e.g. both have
      // a "Birnbaum" zone -- so scope every candidate to this mower before
      // it's eligible for the name/id fallback below.
      if (scheduleEntity && attrSource !== scheduleEntity) continue;

      // Prefer the strongest association: this scheduler config + zone name.
      if (scheduleEntity && zoneName != null && attrZoneName === String(zoneName)) {
        return st;
      }
      candidates.push({ st, attrZoneName, attrZoneId, attrSource });
    }

    // Zone name is the stable semantic association used by the completion
    // sensors; use it before falling back to numeric zone_id. `candidates`
    // is already scoped to this mower's schedule entity above.
    if (zoneName != null) {
      const wanted = String(zoneName);
      const byName = candidates.find(c => c.attrZoneName === wanted);
      if (byName) return byName.st;
    }

    const wantedId = Number(zoneId);
    const byId = candidates.find(c => c.attrZoneId !== null && c.attrZoneId === wantedId);
    return byId ? byId.st : null;
  }

  /** Find the "<zone> mow enabled" switch entity by its zone_id attribute,
   *  same matching strategy as _findInterval above. Returns null if the
   *  zone has no enabled switch yet (treated as "not enabled" everywhere
   *  this is consulted, the same safe default a brand-new switch starts
   *  at on the backend). */
  /** Like _findEnabled below, but without applying the local-override
   *  bridge -- used internally so the override logic has a single place
   *  to apply on top of whatever the real matching found. */
  _findEnabledRaw(zoneId, zoneName = null, scheduleEntity = null) {
    if (!this._hass) return null;
    const states = this._hass.states;
    const candidates = [];

    for (const eid of Object.keys(states)) {
      if (!eid.startsWith("switch.")) continue;
      const st = states[eid];
      const attrs = st.attributes || {};
      const hasEnabledName = eid.includes("mow_enabled") ||
        String(st.name || attrs.friendly_name || "").toLowerCase().includes("mow enabled");
      if (!hasEnabledName) continue;

      const attrZoneName = attrs.zone_name != null ? String(attrs.zone_name) : "";
      const attrZoneId = attrs.zone_id != null ? Number(attrs.zone_id) : null;
      const attrSource = attrs.source_entity != null ? String(attrs.source_entity) : "";

      // Same cross-mower scoping as _findInterval above.
      if (scheduleEntity && attrSource !== scheduleEntity) continue;

      if (scheduleEntity && zoneName != null && attrZoneName === String(zoneName)) {
        return st;
      }
      candidates.push({ st, attrZoneName, attrZoneId, attrSource });
    }

    if (zoneName != null) {
      const wanted = String(zoneName);
      const byName = candidates.find(c => c.attrZoneName === wanted);
      if (byName) return byName.st;
    }

    const wantedId = Number(zoneId);
    const byId = candidates.find(c => c.attrZoneId !== null && c.attrZoneId === wantedId);
    return byId ? byId.st : null;
  }

  /** Find the "<zone> mow enabled" switch entity by its zone_id attribute,
   *  same matching strategy as _findInterval above. Returns null if the
   *  zone has no enabled switch yet (treated as "not enabled" everywhere
   *  this is consulted, the same safe default a brand-new switch starts
   *  at on the backend).
   *
   *  Also consults a small local-override map, the same bridging pattern
   *  _findInterval uses for the interval slider: the moment a checkbox
   *  commits, its new value is recorded there so the row and the preview
   *  reflect it immediately instead of waiting for the round trip back
   *  from Home Assistant. */
  _findEnabled(zoneId, zoneName = null, scheduleEntity = null) {
    const st = this._findEnabledRaw(zoneId, zoneName, scheduleEntity);
    const override = this._localEnabledOverrides && this._localEnabledOverrides[zoneId];
    if (override === undefined) return st;
    if (st && (st.state === "on") === override) {
      // The real entity has already caught up to the override -- stop
      // masking it so a later external change (e.g. via the entity's own
      // more-info dialog) isn't shadowed forever.
      delete this._localEnabledOverrides[zoneId];
      return st;
    }
    return { ...(st || {}), state: override ? "on" : "off" };
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
      (NavimowZoneIntervalCardImpl._startOfDay(new Date()) - NavimowZoneIntervalCardImpl._startOfDay(d)) /
        86400000
    );
    let text;
    if (days <= 0) text = "today";
    else if (days === 1) text = "yesterday";
    else text = `${days} days ago`;
    return { text, days };
  }

  _rowHtml(z) {
    const lm = this._findCompleted(z.id, z.name, this._config.entity);
    const age = this._fmtAge(lm);
    const isManual = !!(lm && lm.attributes && lm.attributes.manual);
    const markBtn = this._findMarkCompletedButton(z.id, z.name, this._config.entity);
    const intervalState = this._findInterval(z.id, z.name, this._config.entity);
    const intervalDays = intervalState ? Number(intervalState.state) : 0;
    const enabledState = this._findEnabled(z.id, z.name, this._config.entity);
    const isEnabled = !!enabledState && enabledState.state === "on";
    // Sourced from the last `get_due_zones` response (see
    // _refreshDueToday()) -- the same calculation mow_due_zones/
    // save_due_schedule use -- not a local recomputation. Until the first
    // response has arrived, no row is highlighted rather than guessing.
    const overdue = !!(this._dueZoneIds && this._dueZoneIds.has(z.id));
    const checkboxHtml = enabledState
      ? `<input type="checkbox" class="nmz-enable" ${isEnabled ? "checked" : ""} ` +
        `data-entity="${enabledState.entity_id}" data-zone-id="${z.id}" />`
      : `<input type="checkbox" class="nmz-enable" disabled title="no mow-enabled entity for this zone yet" />`;
    let sliderHtml;
    if (intervalState) {
      const value = Number(intervalState.state);
      const attrs = intervalState.attributes || {};
      const min = attrs.min !== undefined ? Number(attrs.min) : 1;
      const max = attrs.max !== undefined ? Number(attrs.max) : 7;
      const step = attrs.step !== undefined ? Number(attrs.step) : 1;
      sliderHtml =
        `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" ` +
        `data-entity="${intervalState.entity_id}" data-zone-id="${z.id}" class="nmz-slider" ` +
        `${isEnabled ? "" : "disabled"} />` +
        `<span class="nmz-value">${value}d</span>`;
    } else {
      sliderHtml = `<span class="nmz-missing">no mow-interval entity for this zone yet</span>`;
    }
    const manualHtml = isManual ? ` <span class="nmz-manual">(manual)</span>` : "";
    return (
      `<div class="nmz-row${isEnabled ? "" : " nmz-row-off"}">` +
      checkboxHtml +
      `<div class="nmz-name${overdue ? " nmz-overdue" : ""}${!isEnabled ? " nmz-disabled" : ""}">${z.name || `Zone ${z.id}`}</div>` +
      (markBtn
        ? `<div class="nmz-age nmz-age-clickable" data-mark-entity="${markBtn.entity_id}" ` +
          `data-zone-id="${z.id}" data-zone-name="${this._escapeHtmlAttr(z.name || `Zone ${z.id}`)}" ` +
          `title="Click to mark this zone completed now">${age.text}${manualHtml}</div>`
        : `<div class="nmz-age">${age.text}${manualHtml}</div>`) +
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

  /** Call one of this integration's read-only/action services for this
   *  card's schedule entity. Every "which zones are due" answer in this
   *  card comes through here -- there is no client-side reimplementation
   *  of that calculation left, so the row highlight, the Mow-now button,
   *  the 7-day preview, and Save-to-mower can never disagree with each
   *  other or with an automation calling the same services directly. */
  async _callDueService(service, extra = {}, returnResponse = true) {
    const result = await this._hass.callService(
      "navimower_zone_scheduler",
      service,
      { schedule_entity: this._config.entity, ...extra },
      undefined,
      true,
      returnResponse
    );
    return returnResponse ? result && result.response : result;
  }

  /** Fetch today's due zones from the backend `get_due_zones` service and
   *  cache the result for `_rowHtml()`'s overdue highlight. Coalesces
   *  overlapping calls (e.g. several state changes arriving in a burst)
   *  into one in-flight request, and only triggers a re-render if the due
   *  set actually changed, so this can't loop against `_render()`. */
  async _refreshDueToday(force = false) {
    if (!this._hass || !this._config || this._dueTodayFetching) return;
    // Throttle passive refreshes (e.g. triggered from every _render() call,
    // which can fire every few seconds while the mower is active) so this
    // doesn't hammer get_due_zones; explicit refreshes right after an
    // action (a toggle, Mow-now, Save) pass force=true to bypass this.
    if (!force && this._dueTodayFetchedAt && Date.now() - this._dueTodayFetchedAt < 5000) {
      return;
    }
    this._dueTodayFetching = true;
    try {
      const details = await this._callDueService("get_due_zones");
      const ids = new Set((details && details.zone_ids) || []);
      const changed =
        !this._dueZoneIds ||
        ids.size !== this._dueZoneIds.size ||
        [...ids].some((id) => !this._dueZoneIds.has(id));
      this._dueZoneIds = ids;
      this._dueTodayFetchedAt = Date.now();
      if (changed) this._render();
    } catch (err) {
      // Leave the previous (possibly stale) highlight in place rather than
      // clearing it on a transient error -- a blip shouldn't make every
      // row suddenly look "not due".
    } finally {
      this._dueTodayFetching = false;
    }
  }

  /** Fetch the next-7-days projection from the backend `preview_due_schedule`
   *  service -- the exact same calculation `save_due_schedule` uses to
   *  decide what to write, so the preview table can never show something
   *  different from what "Save to mower" would actually save. */
  async _buildPreview() {
    const details = await this._callDueService("preview_due_schedule", { days: 7 });
    const daysOut = (details && details.days) || [];
    const nameById = {};
    const days = daysOut.map((d) => {
      const [y, m, day] = d.date.split("-").map(Number);
      d.zone_ids.forEach((id, i) => {
        nameById[id] = d.zone_names[i];
      });
      return { date: new Date(y, m - 1, day), zoneIds: d.zone_ids };
    });

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
    await this._buildPreview();
    this._renderPreview();

    const daysWithZones = (this._previewDays || []).filter((d) => d.zoneIds.length > 0);
    if (!daysWithZones.length) {
      this._previewStatus = "Nothing to save \u2014 no zone is due in the next 7 days.";
      this._renderPreview();
      return;
    }
    const weekdays = daysWithZones.map((d) => NavimowZoneIntervalCardImpl.WEEKDAY_EN[d.date.getDay()]);
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
      // The single navimower_zone_scheduler.save_due_schedule call below
      // re-simulates and writes every due day itself -- this is the same
      // service an automation would call, so there's no separate
      // per-weekday navimower.set_schedule loop here to drift from it.
      await this._callDueService(
        "save_due_schedule",
        { device_id: this._config.device_id, start, end, days: 7 },
        false
      );
      this._previewStatus = `Saved ${daysWithZones.length} day(s) to the mower.`;
    } catch (err) {
      this._previewStatus = `Failed: ${(err && err.message) || err}`;
    }
    this._renderPreview();
    this._refreshDueToday(true);
  }

  async _mowDueNow() {
    if (!this._config.device_id) {
      this._els.mowNowStatus.textContent =
        "Set 'device_id' in the card config first (Settings \u2192 Devices \u2192 open the mower \u2192 copy its ID).";
      return;
    }
    let details;
    try {
      details = await this._callDueService("get_due_zones");
    } catch (err) {
      this._els.mowNowStatus.textContent = `Failed: ${(err && err.message) || err}`;
      return;
    }
    const dueZones = (details && details.due_zones) || [];
    if (!dueZones.length) {
      this._els.mowNowStatus.textContent = "Nothing due today.";
      return;
    }
    const names = dueZones.map((z) => z.name).join(", ");
    const confirmed = window.confirm(`Start mowing now: ${names}?`);
    if (!confirmed) return;

    this._els.mowNowStatus.textContent = "Starting\u2026";
    try {
      // navimower_zone_scheduler.mow_due_zones recomputes today's due list
      // itself (rather than trusting the list gathered a moment ago for
      // the confirm dialog above), so a zone completed via the app in the
      // meantime can't get mowed twice.
      await this._callDueService(
        "mow_due_zones",
        { device_id: this._config.device_id, reset: false },
        false
      );
      this._els.mowNowStatus.textContent = `Mowing started: ${names}.`;
    } catch (err) {
      this._els.mowNowStatus.textContent = `Failed: ${(err && err.message) || err}`;
    }
    // "Due today" feeds into day 1's carry-forward assumption in the 7-day
    // preview -- refresh both it (if open) and the row highlight.
    this._refreshDueToday(true);
    if (this._previewDays) {
      await this._buildPreview();
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

    // Passive, throttled refresh of the backend's due-zone list so row
    // highlighting stays current even without an explicit action; see
    // _refreshDueToday()'s own throttle for why this is safe to call on
    // every render.
    this._refreshDueToday();

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

    // Don't rip a slider out from under an in-progress drag.
    const active = document.activeElement;
    const rowsFocused = active && this._els.rows.contains(active) && active.tagName === "INPUT";
    if (!rowsFocused) {
      this._els.rows.innerHTML = zones.map((z) => this._rowHtml(z)).join("");
      this._els.rows.querySelectorAll(".nmz-enable").forEach((el) => {
        el.addEventListener("change", async (e) => {
          const entity = e.target.getAttribute("data-entity");
          const zoneId = e.target.getAttribute("data-zone-id");
          if (!entity) return;
          const checked = e.target.checked;
          await this._hass.callService("switch", checked ? "turn_on" : "turn_off", {
            entity_id: entity,
          });
          // Bridge the gap until hass reflects the new value (see
          // _findEnabled's override handling), then re-render so this
          // row's greyed-out state reflects the change immediately, and
          // refresh due-status/preview from the backend now that the
          // switch has actually landed.
          if (zoneId) {
            this._localEnabledOverrides = this._localEnabledOverrides || {};
            this._localEnabledOverrides[zoneId] = checked;
          }
          this._render();
          this._refreshDueToday(true);
          if (this._previewDays) {
            await this._buildPreview();
            this._renderPreview();
          }
        });
      });
      this._els.rows.querySelectorAll(".nmz-slider").forEach((el) => {
        // Live-update the number label while dragging, without hammering
        // the service call on every pixel of drag.
        el.addEventListener("input", (e) => {
          const wrap = e.target.closest(".nmz-slider-wrap");
          const label = wrap && wrap.querySelector(".nmz-value");
          if (label) label.textContent = `${e.target.value}d`;
        });
        // Commit to Home Assistant only once the drag/click is released.
        el.addEventListener("change", async (e) => {
          const entity = e.target.getAttribute("data-entity");
          const zoneId = e.target.getAttribute("data-zone-id");
          const value = Number(e.target.value);
          await this._hass.callService("number", "set_value", { entity_id: entity, value });
          // Bridge the gap until hass reflects the new value (see
          // _findInterval's override handling) for this row's own display;
          // the due-zone refresh below is awaited until after the service
          // call above resolves, so it's never asking the backend before
          // the new interval has actually landed.
          if (zoneId) {
            this._localOverrides = this._localOverrides || {};
            this._localOverrides[zoneId] = value;
          }
          this._refreshDueToday(true);
          if (this._previewDays) {
            await this._buildPreview();
            this._renderPreview();
          }
        });
      });
      this._els.rows.querySelectorAll(".nmz-age-clickable").forEach((el) => {
        el.addEventListener("click", async (e) => {
          const entity = e.currentTarget.getAttribute("data-mark-entity");
          const zoneId = e.currentTarget.getAttribute("data-zone-id");
          const zoneName = e.currentTarget.getAttribute("data-zone-name") || `Zone ${zoneId}`;
          if (!entity) return;
          const confirmed = window.confirm(`Mark "${zoneName}" as completed now?`);
          if (!confirmed) return;
          await this._hass.callService("button", "press", { entity_id: entity });
          // Bridge the gap until the backend's floor write + the mirrored
          // completion sensor both catch up (see _findCompleted's
          // override handling), so the row shows "today" immediately
          // instead of waiting for that round trip.
          if (zoneId) {
            this._localCompletedOverrides = this._localCompletedOverrides || {};
            this._localCompletedOverrides[zoneId] = Date.now();
          }
          this._render();
          this._refreshDueToday(true);
          if (this._previewDays) {
            await this._buildPreview();
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

    // Weekday name only -- no calendar date -- since the preview always
    // covers exactly the next 7 days, so no two rows can land on the same
    // weekday and the date itself adds nothing the weekday doesn't already
    // convey.
    const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: "long" });
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

// No customElements.define() for the card itself here -- see the class
// doc comment above. The editor below is still a real custom element,
// registered the normal way, since it's only ever created on demand
// (opening a card's visual editor) well after this module has already
// loaded, so it isn't exposed to the startup race the card itself was.

/** Minimal ha-form based visual editor for the static fields
 *  (entity/title/device_id/start/end). No more per-zone entity-override
 *  schema here -- see the card class doc comment for why: every "which
 *  zone is due" decision now comes from the backend services (single
 *  implementation, single source of truth), so a per-card "last
 *  completed" override would have nothing left to feed into and would
 *  only risk the display disagreeing with what Mow-now/Save-to-mower
 *  actually do. A zone whose auto-matched completion sensor is wrong
 *  should be fixed once, centrally, on that zone's "completion source"
 *  select entity (select.py) -- that fix reaches this card, every other
 *  dashboard, and the backend services alike.
 */
class NavimowZoneIntervalCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() {
    this._render();
  }

  _computeLabel(schema) {
    return NavimowZoneIntervalCardEditor.LABELS[schema.name] || schema.name;
  }

  _render() {
    if (!this.isConnected) return;
    if (!this._form) {
      this.innerHTML = `<ha-form></ha-form>`;
      this._form = this.querySelector("ha-form");
      this._form.computeLabel = (schema) => this._computeLabel(schema);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
        );
      });
    }
    if (this._hass) this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = NavimowZoneIntervalCardEditor.BASE_SCHEMA;
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

// Guarded: if this module ends up executing twice in one session (e.g. a
// version bump lands mid-session and the shim's loader fetches the new
// URL fresh), a second define() for an already-registered tag throws
// uncaught and would abort the rest of this module -- harmless no-op
// instead.
if (!customElements.get("navimow-zone-interval-card-editor")) {
  customElements.define("navimow-zone-interval-card-editor", NavimowZoneIntervalCardEditor);
}

export { NavimowZoneIntervalCardImpl };

// The window.customCards gallery entry (for the dashboard's "Add Card"
// picker) has no dependency on any of the above and needs no rendering
// -- it's just static metadata -- so it lives in the shim instead, which
// registers it the instant the shim itself loads rather than waiting on
// this impl module. See navimow-zone-interval-card.js.
