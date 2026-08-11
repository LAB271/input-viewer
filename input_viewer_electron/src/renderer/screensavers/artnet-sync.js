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
 * RELEASE BEHAVIOUR
 *
 * When the screensaver stops, the relay simply stops being driven and the
 * fixtures keep their last colour. Blackout was rejected: it would plunge a room
 * that may have people in it into darkness. A scene restore is available via
 * `artnetReleaseScene` for anyone who wants it, unset by default so nothing is
 * sent and so this does not fight whatever normally owns the lights.
 */

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
      maxBrightness: typeof c.maxBrightness === 'number' ? c.maxBrightness : 1
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
      post(colourEndpoint(cfg.url, cfg.target), {
        r: col.r, g: col.g, b: col.b,
        brightness,
        transition_ms: TRANSITION_MS
      }).finally(() => { inFlight = false })
    },

    /**
     * Stop driving the lights.
     *
     * By default this sends nothing: the fixtures keep their last colour, so a
     * room with people in it does not suddenly go dark and whatever normally
     * owns the lighting takes over on its next command. A scene is posted only
     * if one is configured.
     */
    release() {
      const cfg = config()
      if (!cfg.enabled || !cfg.url || !cfg.releaseScene) return
      const scene = encodeURIComponent(cfg.releaseScene)
      const base = cfg.url.replace(/\/+$/, '')
      post(`${base}/scenes/${scene}`, {})
    },

    /** Diagnostics for the settings UI and the tests. */
    getStatus() {
      return {
        sent,
        failures,
        lastError,
        lastColour,
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
