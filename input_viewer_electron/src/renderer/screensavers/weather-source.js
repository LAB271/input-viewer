// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Live weather readings for the weather screensaver (issue #101).
 *
 * This is deliberately **not** part of the screensaver. Every other saver is
 * self-contained maths on a canvas; this one has an external dependency and
 * asynchronous state, which makes it the first saver that can *fail*. Issue #101
 * is mostly about that rather than about the animation.
 *
 * WHY THE POLLER LIVES OUT HERE
 *
 * `registry.startScreensaver()` is synchronous, and its failure handling is a
 * `try { create(); start() } catch`. A fetch that rejects resolves *after*
 * `start()` has returned, so the registry cannot catch it: a naive
 * implementation gets a permanently blank canvas and an unhandled rejection.
 *
 * Of the three approaches #101 sketches, this is option 3, chosen and recorded
 * on the issue before any of it was written. The weather is polled here,
 * independently of the screensaver lifecycle, and the last good reading is kept
 * in memory. The saver reads whatever is cached and declines to be picked when
 * there is nothing (`isAvailable()` in registry.js). Consequences worth naming:
 *
 * - **Activation never blocks on the network.** No-signal never waits on HTTP.
 * - **A wall that boots offline** simply never offers the saver, instead of
 *   showing a blank one and falling back.
 * - **The timer cannot leak.** #101 flags that this would be the first saver
 *   holding a non-GL resource, and that a leaked interval survives every
 *   subsequent screensaver. The saver never owns the timer, so its `stop()` has
 *   nothing to forget.
 *
 * DATA SOURCE
 *
 * Open-Meteo, which needs no API key and no account -- nothing secret to store
 * and nothing for an operator to leak. Free for non-commercial use under CC-BY.
 *
 * The CSP at index.html already allows `connect-src https://*`, verified rather
 * than assumed: no CSP change is needed for this.
 *
 * PRIVACY
 *
 * The configured coordinates go to a third party on every poll. They are rounded
 * to two decimals (~1km) before leaving the process -- weather does not need
 * better, and the raw value is nobody's business. The feature is off unless
 * `weatherEnabled` is set. See the README note.
 */

/** Open-Meteo current-conditions endpoint. No key, no account. */
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

const FIELDS = [
  'temperature_2m',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'weather_code',
  'is_day'
].join(',')

// Open-Meteo refreshes roughly every 15 minutes, so polling faster is pure waste
// and rude to a free service. #101 asks for 10-15 minutes; this is the top of
// that range because nothing here is time-critical.
export const POLL_INTERVAL_MS = 15 * 60 * 1000

// Backoff on repeated failure, so an offline wall does not hammer the endpoint
// every 15 minutes for weeks. Doubles from one minute to one hour and stops
// growing; a single number, not an array, so nothing accumulates over a long run
// (#101 explicitly warns about growing retry state on a wall that runs for
// weeks).
const BACKOFF_MIN_MS = 60 * 1000
const BACKOFF_MAX_MS = 60 * 60 * 1000

// Give up on a request well inside the poll interval. Without this a connection
// that opens and never answers -- DNS resolves, nothing comes back -- would hold
// the poll slot indefinitely.
const REQUEST_TIMEOUT_MS = 10 * 1000

// A reading older than this is shown with its age in the readout, so a viewer can
// tell "calm weather" from "stale data" at a glance (#101).
export const STALE_AFTER_MS = 30 * 60 * 1000

// ...and past this it is not worth animating at all. Half a day of weather can
// change completely; a wall confidently showing yesterday's rain is worse than
// one showing a different screensaver.
export const EXPIRE_AFTER_MS = 12 * 60 * 60 * 1000

/**
 * Round coordinates before they leave the process.
 *
 * Two decimals is ~1.1km at the equator and less at Dutch latitudes, which is
 * far finer than any weather model's grid. Precision beyond this leaks where
 * someone is for no benefit.
 *
 * @param {number} n
 * @returns {number}
 */
export function coarsen(n) {
  return Math.round(n * 100) / 100
}

/**
 * Validate and normalise the `current` block of an Open-Meteo response.
 *
 * Returns null rather than throwing on anything unexpected, because "the JSON
 * was not what we expected" and "the network is down" should behave identically
 * from the caller's point of view -- both mean "no reading".
 *
 * Note on units, which the issue got slightly wrong: `precipitation` is
 * millimetres accumulated over `interval` seconds (900 by default), NOT mm/h.
 * It is converted to mm/h here so the animation can reason in a rate.
 *
 * @param {any} json
 * @returns {object|null}
 */
export function parseReading(json) {
  const c = json && json.current
  if (!c || typeof c !== 'object') return null

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const temperature = num(c.temperature_2m)
  const windSpeed = num(c.wind_speed_10m)
  const cloudCover = num(c.cloud_cover)
  // A partial response is a failed response. Temperature, wind and cloud drive
  // the whole scene, so accepting a reading missing any of them would render
  // something confidently wrong.
  if (temperature === null || windSpeed === null || cloudCover === null) return null

  const precipMm = num(c.precipitation)
  const intervalS = num(c.interval) || 900
  return {
    // Observation time as reported, kept for the readout. Not used for staleness:
    // the local clock is what tells us how long ago WE saw it, and a wall with a
    // skewed clock should still show its own idea of age consistently.
    observedAt: typeof c.time === 'string' ? c.time : null,
    temperatureC: temperature,
    // mm over the interval -> mm/h.
    precipitationMmH: precipMm === null ? 0 : (precipMm * 3600) / intervalS,
    windSpeedKmh: Math.max(0, windSpeed),
    windDirectionDeg: num(c.wind_direction_10m) ?? 0,
    cloudCoverPct: Math.min(100, Math.max(0, cloudCover)),
    weatherCode: num(c.weather_code) ?? 0,
    isDay: c.is_day === 1 || c.is_day === true
  }
}

/**
 * Create a weather poller.
 *
 * Nothing happens until `start()`, and `start()` is a no-op without coordinates
 * -- an install that is not meant to reach the internet stays silent.
 *
 * @param {object} options
 * @param {() => ({enabled: boolean, latitude: number|null, longitude: number|null})} options.getConfig
 *   read at each poll rather than captured, so toggling the setting takes effect
 *   without restarting the poller
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {() => number} [options.now] injectable for tests
 * @param {(ms: number, fn: () => void) => any} [options.setTimer] injectable for tests
 * @param {(id: any) => void} [options.clearTimer]
 */
export function createWeatherSource(options) {
  const {
    getConfig,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    now = () => Date.now(),
    setTimer = (ms, fn) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id)
  } = options

  let timer = null
  let running = false
  let reading = null        // last good reading
  let fetchedAt = 0         // local clock at the moment we received it
  let consecutiveFailures = 0
  let lastError = null
  let inFlight = false

  /** Milliseconds until the next attempt. */
  function nextDelay() {
    if (consecutiveFailures === 0) return POLL_INTERVAL_MS
    const grown = BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1)
    return Math.min(grown, BACKOFF_MAX_MS)
  }

  async function pollOnce() {
    // Guard against overlap: a slow request plus a fired timer would otherwise
    // run two fetches at once.
    if (inFlight) return
    const cfg = getConfig() || {}
    if (!cfg.enabled || cfg.latitude == null || cfg.longitude == null) {
      // Not configured is not a failure -- no backoff, no error state. Just
      // nothing to do, checked again on the next tick in case settings changed.
      lastError = null
      return
    }
    if (!fetchImpl) { lastError = 'no fetch available'; return }

    inFlight = true
    const params = new URLSearchParams({
      latitude: String(coarsen(cfg.latitude)),
      longitude: String(coarsen(cfg.longitude)),
      current: FIELDS
    })
    // AbortSignal.timeout is not in every runtime the tests may use, so fall
    // back to a manual controller.
    const controller = new AbortController()
    const abortId = setTimer(REQUEST_TIMEOUT_MS, () => controller.abort())
    try {
      const res = await fetchImpl(`${ENDPOINT}?${params}`, { signal: controller.signal })
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`)
      const parsed = parseReading(await res.json())
      if (!parsed) throw new Error('unexpected response shape')
      reading = parsed
      fetchedAt = now()
      consecutiveFailures = 0
      lastError = null
    } catch (err) {
      consecutiveFailures++
      lastError = err && err.message ? err.message : String(err)
      // Deliberately swallowed. #101's whole point is that this must never
      // become an unhandled rejection on the no-signal path; the cached reading
      // (if any) keeps being animated, and the saver stops offering itself once
      // the cache expires.
      console.warn(`[Weather] poll failed (${consecutiveFailures}x): ${lastError}`)
    } finally {
      clearTimer(abortId)
      inFlight = false
    }
  }

  function schedule() {
    if (!running) return
    timer = setTimer(nextDelay(), async () => {
      await pollOnce()
      schedule()
    })
  }

  return {
    /** Begin polling. Safe to call twice. */
    start() {
      if (running) return
      running = true
      // Fire immediately so a reading exists as soon as possible, then settle
      // into the interval. This is not on the activation path, so its latency
      // costs nothing.
      pollOnce().finally(() => schedule())
    },

    /** Stop polling and release the timer. The cached reading is kept. */
    stop() {
      running = false
      if (timer != null) { clearTimer(timer); timer = null }
    },

    /**
     * The current reading, or null when there is none or it has expired.
     * @returns {object|null}
     */
    getReading() {
      if (!reading) return null
      const age = now() - fetchedAt
      if (age > EXPIRE_AFTER_MS) return null
      return { ...reading, ageMs: age, stale: age > STALE_AFTER_MS }
    },

    /** Diagnostics for the settings UI and the tests. */
    getStatus() {
      return {
        running,
        hasReading: Boolean(reading),
        ageMs: reading ? now() - fetchedAt : null,
        consecutiveFailures,
        lastError,
        nextDelayMs: nextDelay()
      }
    },

    /** Force an immediate poll. Exposed for tests and a settings "test" button. */
    pollNow: pollOnce
  }
}

// The one instance the saver reads. A module-level singleton rather than
// something threaded through create(): the saver is constructed by the registry,
// which knows nothing about weather, and the poller's lifetime is the app's
// rather than any one activation's.
let shared = null

/**
 * Install the shared poller. Called once from renderer.js with a settings
 * accessor; calling it again replaces the previous one (and stops it).
 * @param {object} options same shape as createWeatherSource
 */
export function installWeatherSource(options) {
  if (shared) shared.stop()
  shared = createWeatherSource(options)
  return shared
}

/** @returns {object|null} the shared poller, or null when none is installed */
export function getWeatherSource() {
  return shared
}

/**
 * The reading the saver should animate, or null.
 *
 * Null covers every "no weather" case identically -- feature off, no
 * coordinates, never reached the network, or the cache has expired -- which is
 * what lets the saver's availability check be a single expression.
 *
 * @returns {object|null}
 */
export function currentReading() {
  if (injected) return injected
  return shared ? shared.getReading() : null
}

/** Test seam: drop the shared instance. */
export function __resetWeatherSource() {
  if (shared) shared.stop()
  shared = null
}

// Injected reading, for the preview harness and the tests. Takes precedence over
// the shared poller when set.
let injected = null

/**
 * Pin a reading without touching the network.
 *
 * This exists because the interesting states -- heavy rain, snow, fog, a
 * thunderstorm at night -- cannot be reviewed by waiting for the weather to
 * oblige. #101's verification section asks for precipitation, wind, cloud cover
 * and day/night to be visibly checked; without a seam that is unverifiable by
 * anyone, including the reviewer.
 *
 * Nothing in the app calls this. It is driven by `preview.js` (the W key cycles
 * canned states) and by the unit tests. Pass null to hand control back to the
 * poller.
 *
 * @param {object|null} reading
 */
export function __injectReading(reading) {
  injected = reading
    ? { ageMs: 0, stale: false, ...reading }
    : null
}

/** @returns {object|null} the injected reading, if any */
export function __injectedReading() {
  return injected
}
