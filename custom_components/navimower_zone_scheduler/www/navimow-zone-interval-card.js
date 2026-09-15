/**
 * navimow-zone-interval-card -- registration shim.
 *
 * This file is deliberately tiny and does nothing except define the
 * `navimow-zone-interval-card` custom element *synchronously*, at
 * module-evaluation time, with zero dependencies. Everything else (all
 * ~1300 lines of actual card logic) lives in
 * navimow-zone-interval-card-impl.js, loaded lazily via dynamic import().
 *
 * Why: Home Assistant serves this card via `add_extra_js_url()`, which
 * boils down to one dynamic `import()` of whatever script is registered,
 * racing against Lovelace parsing the dashboard and trying to build a
 * `<navimow-zone-interval-card>` element. If Lovelace wins that race --
 * more likely on a slow/flaky connection or a backgrounded Android
 * WebView than on a fast desktop browser -- it decides the element
 * doesn't exist and permanently swaps in its own red "Configuration
 * error" card for that dashboard view. It does not retry once the real
 * definition arrives a moment later, so this failure mode used to
 * require closing and reopening the whole app to clear, and clearing the
 * browser/WebView cache never helped -- there was nothing stale being
 * served, just an unlucky one-shot race with no way to recover from a
 * loss.
 *
 * Splitting the heavy implementation out means the file that actually
 * has to win that race is now only this one: small enough to fetch,
 * parse, and register in a small fraction of the time the full card
 * used to take, which makes losing the race far less likely in the
 * first place. And if the *impl* module (loaded after this one has
 * already registered the tag) is what's slow or flaky, that no longer
 * matters to Lovelace at all -- the tag already exists, so instead of an
 * unrecoverable error card, the visible result is just this shim's own
 * "loading..." placeholder for a moment, with automatic retries (see
 * `_loadImpl` below) instead of one unguarded attempt.
 */

// See navimow-zone-interval-card-impl.js's header for why `?v=` is on
// this script's own URL in the first place (read fresh from
// manifest.json by __init__.py, never hand-duplicated). The impl module
// is requested with that same version query string, both so its cache
// gets busted in lockstep with this shim's and so CARD_VERSION inside
// the impl (used only for the little version label in the card's
// title row) reads the same value.
const CARD_VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("v") || "dev";
  } catch (err) {
    return "dev";
  }
})();

const IMPL_URL = (() => {
  try {
    const url = new URL(import.meta.url);
    url.pathname = url.pathname.replace(
      /navimow-zone-interval-card\.js$/,
      "navimow-zone-interval-card-impl.js"
    );
    return url.toString();
  } catch (err) {
    return "navimow-zone-interval-card-impl.js";
  }
})();

// A handful of retries with short, increasing delays -- long enough to
// ride out a transient hiccup (a momentary drop on mobile data, a
// backgrounded WebView throttling the fetch) without making a genuinely
// broken install hang forever. Shared at module scope (not per card
// instance) so multiple mower cards on one dashboard cooperate on a
// single load instead of each retrying independently.
const IMPL_RETRY_DELAYS_MS = [500, 1500, 4000, 8000];

let _implModule = null;
let _implPromise = null;

function _loadImpl() {
  if (_implModule) return Promise.resolve(_implModule);
  if (_implPromise) return _implPromise;

  _implPromise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= IMPL_RETRY_DELAYS_MS.length; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const mod = await import(/* webpackIgnore: true */ IMPL_URL);
        _implModule = mod;
        return mod;
      } catch (err) {
        lastErr = err;
        console.warn(
          `navimow-zone-interval-card: impl load attempt ${attempt + 1} failed`,
          err
        );
        if (attempt < IMPL_RETRY_DELAYS_MS.length) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, IMPL_RETRY_DELAYS_MS[attempt]));
        }
      }
    }
    // Let a future call start a fresh attempt (e.g. the next hass update,
    // which for an active mower can arrive just a few seconds later)
    // instead of this session being stuck on one failed promise forever.
    _implPromise = null;
    throw lastErr;
  })();

  return _implPromise;
}

class NavimowZoneIntervalCardShim extends HTMLElement {
  setConfig(config) {
    // Fails fast, synchronously, for a genuinely missing/invalid config --
    // this doesn't need the impl module at all, and matches the error the
    // full card has always thrown here.
    if (!config || !config.entity) {
      throw new Error(
        "please set 'entity' to a mower's Schedule sensor (sensor.xxx_schedule)"
      );
    }
    this._pendingConfig = config;
    if (this._impl) {
      this._impl.setConfig(config);
      return;
    }
    this._renderLoading();
    this._startLoadingImpl();
  }

  set hass(hass) {
    this._pendingHass = hass;
    if (this._impl) {
      this._impl.hass = hass;
      return;
    }
    // setConfig() normally arrives first and already kicked off loading,
    // but be defensive in case hass ever arrives first.
    this._startLoadingImpl();
  }

  getCardSize() {
    if (this._impl && typeof this._impl.getCardSize === "function") {
      return this._impl.getCardSize();
    }
    return 3;
  }

  static getConfigElement() {
    // The editor tag is defined inside the impl module. Kick off loading
    // it if it isn't already (normally it already is, since the editor
    // can only be opened for a card that's already rendering) and hand
    // back the element regardless -- an element created for a
    // not-yet-defined custom tag is a valid, inert placeholder that the
    // browser automatically upgrades in place the moment the real
    // definition lands, per the custom elements spec, so this self-heals
    // without any extra plumbing here.
    _loadImpl().catch(() => {});
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

  _startLoadingImpl() {
    if (this._implLoading) return;
    this._implLoading = true;
    _loadImpl()
      .then((mod) => {
        this._implLoading = false;
        this._impl = new mod.NavimowZoneIntervalCardImpl(this);
        if (this._pendingConfig) this._impl.setConfig(this._pendingConfig);
        if (this._pendingHass) this._impl.hass = this._pendingHass;
      })
      .catch((err) => {
        this._implLoading = false;
        this._showShimError(err);
      });
  }

  _renderLoading() {
    if (this._impl) return;
    this.innerHTML = `
      <ha-card>
        <div class="nmz-shim-loading">Loading navimow-zone-interval-card${
          CARD_VERSION !== "dev" ? ` v${CARD_VERSION}` : ""
        }...</div>
      </ha-card>
      <style>
        .nmz-shim-loading {
          padding: 14px 16px;
          font-size: 13px;
          opacity: 0.7;
        }
      </style>
    `;
  }

  // Only reached if every retry in _loadImpl() has been exhausted -- a
  // transient hiccup should resolve well before this point. Rendered
  // inside this already-registered element, so it never becomes
  // Lovelace's own unrecoverable "Configuration error" card, and the
  // next setConfig/hass call (e.g. the next hass update) tries loading
  // again from scratch rather than staying stuck.
  _showShimError(err) {
    const message = (err && err.message) || String(err);
    console.error("navimow-zone-interval-card: could not load card implementation", err);
    this.innerHTML = `
      <ha-card>
        <div class="nmz-shim-error">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          <div>
            <div class="nmz-shim-error-title">navimow-zone-interval-card</div>
            <div class="nmz-shim-error-msg">Could not load the card. Will keep retrying automatically.</div>
            <div class="nmz-shim-error-detail"></div>
          </div>
        </div>
      </ha-card>
      <style>
        .nmz-shim-error { display:flex; gap:10px; align-items:flex-start; padding:12px 14px; color: var(--error-color, #db4437); }
        .nmz-shim-error ha-icon { flex: none; margin-top:1px; }
        .nmz-shim-error-title { font-size:13px; font-weight:600; }
        .nmz-shim-error-msg { font-size:12px; opacity:0.85; margin-top:2px; }
        .nmz-shim-error-detail { font-size:11px; opacity:0.65; margin-top:4px; word-break:break-word; }
      </style>
    `;
    this.querySelector(".nmz-shim-error-detail").textContent = message;
  }
}

// Guarded the same way as the editor's define() in the impl module: a
// second define() for an already-registered tag throws uncaught, which
// would otherwise be able to take down a whole dashboard render.
if (!customElements.get("navimow-zone-interval-card")) {
  customElements.define("navimow-zone-interval-card", NavimowZoneIntervalCardShim);
}

// Lives here, not in the impl module, so the card shows up in the
// dashboard's "Add Card" picker the instant this (tiny, fast-loading)
// shim runs, without waiting on the impl module at all -- it's pure
// static metadata with no dependency on anything impl provides.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "navimow-zone-interval-card",
  name: "Navimow Zone Mow Interval",
  description: `Per-zone enable checkbox and 1-7 day mow-interval slider, last-completed status, a standalone Mow-now button, and a 7-day (from tomorrow, weekday-only) schedule preview/save -- all refreshing instantly on change. (v${CARD_VERSION})`,
});
