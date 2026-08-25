// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Art-Net reactive mode: drive the room lighting from the active screensaver
 * (issue #59).
 *
 * While the no-signal screen is up, the dominant colour of whatever is on the
 * wall is posted to the lab's artnet-relay service, which fades the Octostrip
 * fixtures to match. Screen and room idle together.
 *
 * OFF unless configured. This posts to a host on the LAN and physically changes
 * the lighting, so it does nothing at all until `artnetEnabled` is set and a URL
 * is given. There is no default URL: guessing one would be a guess about
 * somebody's network.
 *
 * TWO CORRECTIONS TO THE ISSUE, both recorded on it
 *
 * 1. #59 proposes sampling with a `1x1 drawImage` downscale and `getImageData`.
 *    That needs a 2D context, and the screensaver canvas is WebGL2 for its whole
 *    life -- `getContext('2d')` returns null once any GL saver has run. This is
 *    the same one-context constraint documented in glyph-atlas.js. So sampling
 *    goes through `gl.readPixels` (see sampleFrame in gl-base.js), and because
 *    readback is a pipeline stall it happens at ~1Hz, following the precedent
 *    game-of-life.js already set for its population check.
 *
 * 2. Averaging the frame gives grey. A straight mean over anything colourful
 *    converges on mud and would drive the room to a dull neutral. dominantColour
 *    below uses a saturation-weighted circular mean of hue instead, so a mostly
 *    dark frame with one strong accent sends the accent.
 *
 * TWO MODES
 *
 * `artnetTarget` picks between them. A plain target ('all', 'group:x', 'strip:x')
 * posts one flat colour, which is what #59 asked for. An 'effect:<name>' target
 * instead runs one of the relay's field effects, and 'effect:spot' is the reason
 * this exists: a circle of light that tracks the bright part of the wall along
 * the room, sized by how concentrated that light is. The effect is started once
 * and then nudged with small partial /field/params posts -- restarting it every
 * second would reset its own animation phase and read as a stutter.
 *
 * Only the horizontal axis comes from the picture. The wall is one edge of the
 * room, so screen-x has a real counterpart and screen-y does not; depth is a
 * setting instead of an invention. See DEFAULT_SPOT_DEPTH.
 *
 * RELEASE BEHAVIOUR
 *
 * When the screensaver stops, the relay simply stops being driven and the
 * fixtures keep their last colour. Blackout was rejected: it would plunge a room
 * that may have people in it into darkness. A scene restore is available via
 * `artnetReleaseScene` for anyone who wants it, unset by default so nothing is
 * sent and so this does not fight whatever normally owns the lights.
 */

import { SAMPLE_GRID } from './gl-base.js'

/**
 * How often a colour is sent, at most. The relay fades between values, so a
 * faster rate buys nothing visible and just adds readbacks (each one a GPU
 * pipeline stall) and HTTP requests.
 */
export const SEND_INTERVAL_MS = 1000

/**
 * Fade time asked of the relay. Slightly longer than the send interval so
 * consecutive sends overlap into a continuous glide rather than stepping.
 */
export const TRANSITION_MS = 1400

// Backoff when the relay is unreachable, so a wall left running against a dead
// service does not retry every second for days. Doubles from 5s to 5 minutes and
// stops growing.
const BACKOFF_MIN_MS = 5000
const BACKOFF_MAX_MS = 5 * 60 * 1000

// Abandon a request quickly. The relay is on the LAN; if it has not answered in
// two seconds it is not going to, and holding the slot only delays the next
// sample.
const REQUEST_TIMEOUT_MS = 2000

/**
 * Reduce a pixel buffer to one colour to send to the fixtures.
 *
 * Weighted by saturation and then by brightness, both deliberately:
 *
 * - **Saturation weighting** is what stops the result being grey. A frame that is
 *   90% near-black with a bright cyan filament should send cyan, not dark grey.
 *   Hue is averaged as a circular mean (summing unit vectors) because a plain
 *   numeric mean of hues puts red-and-magenta at green.
 * - **Brightness weighting** keeps near-black pixels from voting at all; they
 *   have no meaningful hue.
 *
 * The returned value is at full saturation with the frame's mean luminance as
 * brightness, because the fixtures look best given a saturated colour and a
 * separate level -- sending a desaturated average makes the room look off rather
 * than dim.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba tightly packed RGBA bytes
 * @returns {{r: number, g: number, b: number, brightness: number}}
 *   r/g/b in 0-255, brightness in 0..1
 */
export function dominantColour(rgba) {
  let sx = 0, sy = 0, satWeight = 0, lumSum = 0, samples = 0

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    lumSum += lum
    samples++

    const chroma = max - min
    if (max <= 0.02 || chroma <= 0.01) continue   // black or grey: no hue to vote

    // Hue in turns, from the standard piecewise definition.
    let h
    if (max === r) h = ((g - b) / chroma) / 6
    else if (max === g) h = (2 + (b - r) / chroma) / 6
    else h = (4 + (r - g) / chroma) / 6
    if (h < 0) h += 1

    // Weight: saturated AND bright pixels carry the most.
    const sat = chroma / max
    const w = sat * sat * lum
    const a = h * Math.PI * 2
    sx += Math.cos(a) * w
    sy += Math.sin(a) * w
    satWeight += w
  }

  const meanLum = samples ? lumSum / samples : 0
  // Perceptual-ish curve so a dim scene still lights the room a little rather
  // than reading as off. Nothing subtle: sqrt.
  const brightness = Math.min(1, Math.sqrt(Math.max(0, meanLum)))

  if (satWeight <= 1e-6) {
    // Genuinely monochrome frame -- matrix rain in classic green aside, this is
    // the white-particles and DVD-on-black case. Send warm white and let
    // brightness carry it.
    return { r: 255, g: 214, b: 170, brightness }
  }

  let hue = Math.atan2(sy, sx) / (Math.PI * 2)
  if (hue < 0) hue += 1
  const [r, g, b] = hueToRgb255(hue)
  return { r, g, b, brightness }
}

/**
 * Fully saturated, full-value RGB for a hue in turns.
 * @param {number} h 0..1
 * @returns {[number, number, number]} each 0-255
 */
export function hueToRgb255(h) {
  // Standard HSV->RGB at s=v=1. The `1 -` is not optional: without it every hue
  // comes out as its own complement, which is the kind of bug that looks like a
  // wiring fault in the fixtures rather than a maths error here.
  const f = (n) => {
    const k = (n + h * 6) % 6
    const v = 1 - Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
  }
  return [f(5), f(3), f(1)]
}

/**
 * Spot diameter range, in field units (the relay's field is normalised 0..1).
 * Driven by how concentrated the light on the wall is: a single bright filament
 * gives a tight spot, a full-frame wash gives a broad one.
 */
export const SPOT_DIAMETER_MIN = 0.18
export const SPOT_DIAMETER_MAX = 0.8

/** Edge softness asked of the spot. Mid-range: a hard edge reads as a fault. */
export const SPOT_SOFTNESS = 0.55

/**
 * Where in the room the spot sits, front to back. Configurable via `spotDepth`;
 * the default is the middle of the floor.
 *
 * This is a CONSTANT rather than something driven from the frame, deliberately.
 * The videowall is one edge of the room, so the frame's horizontal axis has a
 * real spatial counterpart -- bright on the left of the wall is bright on the
 * left of the room -- but the frame's vertical axis does not. Mapping screen-y
 * to room depth would be an invention, and an invention that looks like a bug
 * ("why does the spot walk backwards when the animation rises?"). So x tracks
 * the picture, depth is a setting, and size carries the rest.
 */
export const DEFAULT_SPOT_DEPTH = 0.5

/**
 * Locate the light in a sampled frame.
 *
 * Returns the luminance-weighted centroid of the sample grid in **screen**
 * coordinates -- (0,0) top-left, (1,1) bottom-right -- plus how spread out that
 * light is horizontally.
 *
 * THE Y FLIP IS LOAD-BEARING. gl.readPixels has its origin at the bottom-left,
 * so the grid's first tile row is the BOTTOM of the picture (see SAMPLE_GRID).
 * Reporting those rows as-is would put the centroid upside-down; harmless for
 * `cx`, but this function returns `cy` too and a caller has every right to trust
 * it. Flipped here, once, rather than at each call site.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba packed RGBA from the sample grid
 * @param {{tile: number, tilesX: number, tilesY: number}} [grid]
 * @returns {{cx: number, cy: number, spread: number, weight: number}}
 *   cx/cy in 0..1 screen space, spread 0..1, weight = mean luminance
 */
export function luminanceFocus(rgba, grid = SAMPLE_GRID) {
  const { tile, tilesX, tilesY } = grid
  const perTile = tile * tile * 4
  let wx = 0, wy = 0, wsum = 0, wxx = 0

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const base = (ty * tilesX + tx) * perTile
      if (base + perTile > rgba.length) continue
      let lum = 0
      for (let i = base; i < base + perTile; i += 4) {
        lum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]
      }
      // Mean luminance of the tile, 0..1, then squared so a bright accent pulls
      // the centroid harder than a large dim area -- the same reasoning as the
      // saturation weighting in dominantColour.
      const mean = lum / (tile * tile) / 255
      const w = mean * mean
      if (w <= 0) continue

      const fx = (tx + 0.5) / tilesX
      const fy = 1 - (ty + 0.5) / tilesY   // GL rows are bottom-up; see above
      wx += fx * w
      wy += fy * w
      wxx += fx * fx * w
      wsum += w
    }
  }

  if (wsum <= 1e-9) {
    // Black frame: centre it and go wide rather than parking the spot in a
    // corner because of float noise.
    return { cx: 0.5, cy: 0.5, spread: 1, weight: 0 }
  }

  const cx = wx / wsum
  const variance = Math.max(0, wxx / wsum - cx * cx)
  // A uniform frame has variance 1/12 (~0.083); normalise against that so a
  // full-frame wash reads as spread 1 and a point source as 0.
  const spread = Math.min(1, Math.sqrt(variance) / Math.sqrt(1 / 12))
  return { cx, cy: wy / wsum, spread, weight: Math.sqrt(wsum) }
}

/** Trim float-division noise from a 0..1 field value. */
const round4 = (v) => Math.round(v * 10000) / 10000

/** Map horizontal spread onto a spot diameter. */
export function spotDiameter(spread) {
  const t = Math.max(0, Math.min(1, spread))
  return SPOT_DIAMETER_MIN + (SPOT_DIAMETER_MAX - SPOT_DIAMETER_MIN) * t
}

/**
 * The effect name in a target, or null if the target is a plain colour target.
 *
 * `effect:<name>` selects the relay's field-based effects (spot, ripple, plasma,
 * blobs, tunnel, sweep, aurora) instead of posting a flat colour. Only `spot`
 * takes a position, so only `spot` gets steered; the others still get colour.
 *
 * @param {string} target
 * @returns {string|null}
 */
export function effectNameFor(target) {
  const t = String(target || '').trim()
  if (!t.startsWith('effect:')) return null
  const name = t.slice('effect:'.length).trim()
  return name || null
}

/**
 * Build the relay URL for a colour post from the configured target.
 *
 * The relay exposes `/all`, `/groups/{name}` and `/strips/{name}`, all taking the
 * same ColorRequest body. `all` is the default because it is the only target that
 * exists on every install -- a group or strip name is site-specific.
 *
 * @param {string} baseUrl e.g. http://pi.labs:8000
 * @param {string} target 'all' | 'group:<name>' | 'strip:<name>'
 * @returns {string}
 */
export function colourEndpoint(baseUrl, target) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const t = String(target || 'all').trim()
  if (t === 'all' || t === '') return `${base}/all`
  const [kind, ...rest] = t.split(':')
  const name = encodeURIComponent(rest.join(':'))
  if (kind === 'group' && name) return `${base}/groups/${name}`
  if (kind === 'strip' && name) return `${base}/strips/${name}`
  // Unrecognised target: fall back to /all rather than posting to a made-up
  // path, which would 404 every second and look like the relay was broken.
  return `${base}/all`
}

/** `POST /effects/{name}` -- starts an effect, body is a flat EffectRequest. */
export function effectEndpoint(baseUrl, name) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return `${base}/effects/${encodeURIComponent(name)}`
}

/** `POST /field/params` -- partial update of the running field effect. */
export function fieldParamsEndpoint(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/field/params`
}

/** `POST /stop` -- ends whatever effect is running, leaving the last frame lit. */
export function stopEndpoint(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/stop`
}

/**
 * Default transport: hand the request to the main process over IPC.
 *
 * NOT a plain fetch from the renderer, and this is not a style preference. In
 * production the renderer is loaded with `loadFile()`, so its origin is
 * `file://`; a cross-origin POST carrying `Content-Type: application/json`
 * triggers a CORS preflight, and artnet-relay has no CORS middleware. Verified
 * against a stub relay: it receives `OPTIONS /all` and never a POST. The main
 * process has no origin, so no preflight exists.
 *
 * Falls back to reporting a failure when there is no bridge -- the preview
 * harness has none, and passing `fetchImpl` is how that case opts in instead.
 *
 * @param {{url: string, body: object}} request
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function defaultSend(request) {
  const api = globalThis.window && window.electronAPI
  if (!api || typeof api.artnetSend !== 'function') {
    return { ok: false, error: 'no IPC bridge for artnet-send' }
  }
  return api.artnetSend(request)
}

/**
 * Direct-fetch transport, for the tests and the preview harness.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function directFetch(fetchImpl, url, body, setTimer, clearTimer) {
  const controller = new AbortController()
  const abortId = setTimer(REQUEST_TIMEOUT_MS, () => controller.abort())
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : 'no response'}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  } finally {
    clearTimer(abortId)
  }
}

/**
 * Create an Art-Net sync client.
 *
 * @param {object} options
 * @param {() => ({enabled: boolean, url: string, target: string, releaseScene: string, maxBrightness: number})} options.getConfig
 *   read per send, so toggling the setting takes effect without a restart
 * @param {(request: {url: string, body: object}) => Promise<{ok: boolean, error?: string}>} [options.send]
 *   transport. Defaults to the main process over IPC -- see the CORS note below.
 * @param {typeof fetch} [options.fetchImpl] direct-fetch transport, used by the
 *   tests and by the preview harness where there is no IPC bridge
 * @param {() => number} [options.now] injectable for tests
 * @param {(ms:number, fn:() => void) => any} [options.setTimer]
 * @param {(id:any) => void} [options.clearTimer]
 */
export function createArtnetSync(options) {
  const {
    getConfig,
    send = defaultSend,
    fetchImpl = null,
    now = () => Date.now(),
    setTimer = (ms, fn) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id)
  } = options

  let lastSentAt = 0
  let inFlight = false
  let failures = 0
  let lastError = null
  let sent = 0
  let lastColour = null
  let lastSpot = null
  // Whether the effect is believed to be running on the relay. While false the
  // next send starts it; after that, sends are cheap partial nudges.
  let effectRunning = false

  function backoffUntil() {
    if (failures === 0) return 0
    const grown = BACKOFF_MIN_MS * 2 ** (failures - 1)
    return lastSentAt + Math.min(grown, BACKOFF_MAX_MS)
  }

  function config() {
    const c = getConfig() || {}
    return {
      enabled: Boolean(c.enabled),
      url: c.url || '',
      target: c.target || 'all',
      releaseScene: c.releaseScene || '',
      // Ceiling on how bright the room can be driven, so a white screensaver
      // cannot dazzle. 1 = no limit.
      maxBrightness: typeof c.maxBrightness === 'number' ? c.maxBrightness : 1,
      spotDepth: typeof c.spotDepth === 'number'
        ? Math.max(0, Math.min(1, c.spotDepth))
        : DEFAULT_SPOT_DEPTH
    }
  }

  /** POST helper. Never throws; records failure and backs off. */
  async function post(url, body) {
    try {
      const res = fetchImpl
        ? await directFetch(fetchImpl, url, body, setTimer, clearTimer)
        : await send({ url, body })
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'send failed')
      failures = 0
      lastError = null
      return true
    } catch (err) {
      failures++
      lastError = err && err.message ? err.message : String(err)
      // Swallowed on purpose. This runs from the screensaver's frame loop; a
      // rejection here must never reach the no-signal path, and a dark room is
      // not worth a broken wall.
      console.warn(`[Art-Net] send failed (${failures}x): ${lastError}`)
      return false
    }
  }

  return {
    /**
     * Offer a sampled frame. Cheap to call every frame: rate limiting, the
     * enabled check and the backoff gate all happen here, so the caller does not
     * need to know about any of them.
     *
     * @param {Uint8Array} rgba packed RGBA bytes from the frame
     */
    offerFrame(rgba) {
      const cfg = config()
      if (!cfg.enabled || !cfg.url) return
      const t = now()
      if (t - lastSentAt < SEND_INTERVAL_MS) return
      if (failures > 0 && t < backoffUntil()) return
      if (inFlight) return

      const col = dominantColour(rgba)
      const brightness = Math.max(0, Math.min(1, col.brightness * cfg.maxBrightness))
      lastColour = { ...col, brightness }
      lastSentAt = t
      inFlight = true
      sent++

      const effect = effectNameFor(cfg.target)
      if (effect) {
        const focus = luminanceFocus(rgba)
        // Brightness is PRE-MULTIPLIED into rgb rather than sent as its own
        // field: the field effects take r/g/b/cx/cy/diameter/softness and have
        // no brightness parameter, so a `brightness` key would be silently
        // dropped and maxBrightness would quietly stop working.
        const spot = {
          r: Math.round(col.r * brightness),
          g: Math.round(col.g * brightness),
          b: Math.round(col.b * brightness),
          // Rounded because the centroid is a float division and lands on
          // things like 0.5000000000000001, which is three times the JSON for
          // no extra precision the fixtures could possibly render.
          cx: round4(focus.cx),
          cy: round4(cfg.spotDepth),
          diameter: round4(spotDiameter(focus.spread)),
          softness: SPOT_SOFTNESS
        }
        lastSpot = { effect, ...spot }

        // First send starts the effect (a full EffectRequest); every send after
        // that is a partial /field/params update, which is one small POST rather
        // than a restart -- restarting each second would reset the effect's own
        // animation phase and make it stutter.
        const starting = !effectRunning
        const url = starting ? effectEndpoint(cfg.url, effect) : fieldParamsEndpoint(cfg.url)
        const body = starting ? spot : { params: spot }
        post(url, body)
          .then((ok) => { effectRunning = ok })
          .finally(() => { inFlight = false })
        return
      }

      post(colourEndpoint(cfg.url, cfg.target), {
        r: col.r, g: col.g, b: col.b,
        brightness,
        transition_ms: TRANSITION_MS
      }).finally(() => { inFlight = false })
    },

    /**
     * Stop driving the lights.
     *
     * In colour mode this sends nothing by default: the fixtures keep their last
     * colour, so a room with people in it does not suddenly go dark and whatever
     * normally owns the lighting takes over on its next command. A scene is
     * posted only if one is configured.
     *
     * EFFECT MODE IS DIFFERENT, and it is why this is not simply the same path.
     * A colour that is left alone is static. An *effect* that is left alone keeps
     * running: the room would go on pulsing and sweeping indefinitely after the
     * wall woke up, with nothing driving it and no obvious way for anyone in the
     * room to work out why. So an effect we started is one we stop. A configured
     * release scene still wins, since that both ends the effect and leaves the
     * room somewhere deliberate.
     */
    release() {
      const cfg = config()
      const wasRunning = effectRunning
      effectRunning = false
      if (!cfg.enabled || !cfg.url) return
      if (cfg.releaseScene) {
        const scene = encodeURIComponent(cfg.releaseScene)
        post(`${cfg.url.replace(/\/+$/, '')}/scenes/${scene}`, {})
        return
      }
      if (wasRunning) post(stopEndpoint(cfg.url), {})
    },

    /** Diagnostics for the settings UI and the tests. */
    getStatus() {
      return {
        sent,
        failures,
        lastError,
        lastColour,
        lastSpot,
        effectRunning,
        nextEligibleAt: Math.max(lastSentAt + SEND_INTERVAL_MS, backoffUntil())
      }
    }
  }
}

// One shared client, installed by renderer.js. Module-level for the same reason
// as the weather poller: the thing that constructs savers knows nothing about
// lighting, and this outlives any single activation.
let shared = null

/** Install the shared client, replacing and releasing any previous one. */
export function installArtnetSync(options) {
  if (shared) shared.release()
  shared = createArtnetSync(options)
  return shared
}

/** @returns {object|null} */
export function getArtnetSync() {
  return shared
}

/** Test seam: drop the shared instance without posting a release scene. */
export function __resetArtnetSync() {
  shared = null
}
