// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Art-Net reactive mode (issue #59).
 *
 * Two things are being protected here, and neither is the animation.
 *
 * **It drives physical fixtures.** So: nothing is sent unless it is explicitly
 * enabled AND given a URL, the send rate is bounded, brightness is capped, and
 * stopping the screensaver does not plunge a room into darkness. A bug in this
 * file is visible to everyone standing in the lab.
 *
 * **It runs inside the screensaver's frame loop.** So a failing relay must never
 * throw, never reject into the no-signal path, and never retry fast enough to
 * matter. `offerFrame` is called at 60Hz and must be cheap when it has nothing
 * to do.
 *
 * The payload shape is checked against a stub that mirrors the real relay's
 * `ColorRequest` contract (`lab271_artnet.py`: r, g, b, brightness,
 * transition_ms). The real fixtures are deliberately untouched -- that check
 * belongs to someone standing in the room.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createArtnetSync,
  dominantColour,
  hueToRgb255,
  colourEndpoint,
  SEND_INTERVAL_MS,
  TRANSITION_MS
} from '../src/renderer/screensavers/artnet-sync.js'

/** Controllable clock and timers, so nothing waits on real time. */
function harness() {
  let clock = 1_700_000_000_000
  const timers = new Map()
  let nextId = 1
  return {
    now: () => clock,
    advance(ms) { clock += ms },
    setTimer: (ms, fn) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    async flush(n = 20) { for (let i = 0; i < n; i++) await Promise.resolve() }
  }
}

/**
 * A stub relay that records what it receives, mirroring the real service's
 * responses. This is what stands in for the lab's fixtures.
 */
function stubRelay({ status = 200, fail = false } = {}) {
  const calls = []
  const impl = vi.fn(async (url, init) => {
    if (fail) throw new TypeError('Failed to fetch')
    calls.push({ url, method: init?.method, body: JSON.parse(init?.body || '{}') })
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true }) }
  })
  return { impl, calls }
}

const config = (over = {}) => () => ({
  enabled: true, url: 'http://pi.labs:8000', target: 'all',
  releaseScene: '', maxBrightness: 1, ...over
})

function build(relay, cfg = config(), h = harness()) {
  const sync = createArtnetSync({
    getConfig: cfg, fetchImpl: relay.impl,
    now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer
  })
  return { sync, h }
}

/** A frame buffer of one solid colour. */
function solid(r, g, b, pixels = 512) {
  const buf = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255
  }
  return buf
}

/** Mostly black, with `lit` pixels of one colour: the accent case. */
function accentOnBlack(r, g, b, lit = 8, pixels = 512) {
  const buf = new Uint8Array(pixels * 4)
  for (let i = 0; i < lit; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255
  }
  return buf
}

describe('dominantColour', () => {
  it('returns the hue of a solid frame', () => {
    const { r, g, b } = dominantColour(solid(0, 200, 255))
    // Cyan in, cyan out -- saturated, so hue is preserved exactly.
    expect(b).toBeGreaterThan(200)
    expect(g).toBeGreaterThan(150)
    expect(r).toBeLessThan(80)
  })

  it('sends the accent, not the average, on a mostly-black frame', () => {
    // The reason for saturation weighting. A plain mean over 8 magenta pixels in
    // 512 black ones is almost black; the room should go magenta.
    const { r, g, b } = dominantColour(accentOnBlack(255, 0, 200))
    expect(r).toBeGreaterThan(180)
    expect(b).toBeGreaterThan(120)
    expect(g).toBeLessThan(90)
  })

  it('does not average opposing hues into grey', () => {
    // A plain numeric mean of hue would put red-and-cyan at green. The circular
    // mean either keeps one side or cancels to the monochrome fallback -- what it
    // must never do is invent a hue that is in neither half.
    const buf = new Uint8Array(512 * 4)
    for (let i = 0; i < 256; i++) {
      buf[i * 4] = 255; buf[i * 4 + 3] = 255                      // red
    }
    for (let i = 256; i < 512; i++) {
      buf[i * 4 + 1] = 255; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 255  // cyan
    }
    const { r, g, b } = dominantColour(buf)
    const isGreenish = g > r && g > b
    expect(isGreenish).toBe(false)
  })

  it('falls back to warm white on a monochrome frame', () => {
    // White particles and the DVD logo on black: no hue to report, so the level
    // has to carry it rather than sending an arbitrary colour.
    const { r, g, b, brightness } = dominantColour(solid(180, 180, 180))
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(brightness).toBeGreaterThan(0.5)
  })

  it('reports brightness from the whole frame, not the accent', () => {
    const dim = dominantColour(accentOnBlack(255, 0, 200, 4))
    const bright = dominantColour(solid(255, 0, 200))
    expect(dim.brightness).toBeLessThan(bright.brightness)
    expect(dim.brightness).toBeGreaterThanOrEqual(0)
  })

  it('reports zero brightness for a black frame and does not divide by zero', () => {
    const { brightness, r, g, b } = dominantColour(solid(0, 0, 0))
    expect(brightness).toBe(0)
    for (const v of [r, g, b]) expect(Number.isFinite(v)).toBe(true)
  })

  it('handles an empty buffer', () => {
    expect(() => dominantColour(new Uint8Array(0))).not.toThrow()
    expect(dominantColour(new Uint8Array(0)).brightness).toBe(0)
  })

  it('always returns bytes in range', () => {
    for (const buf of [solid(0, 0, 0), solid(255, 255, 255), solid(12, 200, 7),
      accentOnBlack(3, 250, 190), new Uint8Array(4)]) {
      const c = dominantColour(buf)
      for (const v of [c.r, c.g, c.b]) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
      expect(c.brightness).toBeGreaterThanOrEqual(0)
      expect(c.brightness).toBeLessThanOrEqual(1)
    }
  })
})

describe('hueToRgb255', () => {
  it('hits the primaries at the expected turns', () => {
    expect(hueToRgb255(0)).toEqual([255, 0, 0])
    expect(hueToRgb255(1 / 3)).toEqual([0, 255, 0])
    expect(hueToRgb255(2 / 3)).toEqual([0, 0, 255])
  })

  it('wraps at 1', () => {
    expect(hueToRgb255(1)).toEqual(hueToRgb255(0))
  })
})

describe('colourEndpoint', () => {
  it('builds the paths the relay actually exposes', () => {
    const base = 'http://pi.labs:8000'
    expect(colourEndpoint(base, 'all')).toBe(`${base}/all`)
    expect(colourEndpoint(base, 'group:universe_0')).toBe(`${base}/groups/universe_0`)
    expect(colourEndpoint(base, 'strip:bar_left')).toBe(`${base}/strips/bar_left`)
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(colourEndpoint('http://pi.labs:8000/', 'all')).toBe('http://pi.labs:8000/all')
  })

  it('falls back to /all for an unrecognised target', () => {
    // Better a working target than a made-up path 404ing every second, which
    // would look like the relay was broken.
    expect(colourEndpoint('http://x', 'nonsense')).toBe('http://x/all')
    expect(colourEndpoint('http://x', 'group:')).toBe('http://x/all')
    expect(colourEndpoint('http://x', '')).toBe('http://x/all')
  })

  it('encodes a name with awkward characters', () => {
    expect(colourEndpoint('http://x', 'group:back wall')).toBe('http://x/groups/back%20wall')
  })
})

describe('sending nothing unless configured', () => {
  it('is silent when disabled', () => {
    const relay = stubRelay()
    const { sync } = build(relay, config({ enabled: false }))
    for (let i = 0; i < 100; i++) sync.offerFrame(solid(255, 0, 0))
    expect(relay.impl).not.toHaveBeenCalled()
  })

  it('is silent with no URL, even when enabled', () => {
    // The default state after an upgrade: enabled would be a mistake, but an
    // empty URL must never become a request to a guessed host.
    const relay = stubRelay()
    const { sync } = build(relay, config({ url: '' }))
    for (let i = 0; i < 100; i++) sync.offerFrame(solid(255, 0, 0))
    expect(relay.impl).not.toHaveBeenCalled()
  })

  it('sends nothing on release unless a scene is configured', () => {
    // The decision recorded on #59: the fixtures keep their last colour, so a
    // room with people in it does not go dark.
    const relay = stubRelay()
    const { sync } = build(relay)
    sync.release()
    expect(relay.impl).not.toHaveBeenCalled()
  })

  it('posts the configured scene on release when there is one', () => {
    const relay = stubRelay()
    const { sync } = build(relay, config({ releaseScene: 'warm_wit' }))
    sync.release()
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/scenes/warm_wit')
  })
})

describe('what reaches the relay', () => {
  it('matches the ColorRequest contract', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    sync.offerFrame(solid(0, 200, 255))
    await h.flush()

    expect(relay.calls).toHaveLength(1)
    const { url, method, body } = relay.calls[0]
    expect(method).toBe('POST')
    expect(url).toBe('http://pi.labs:8000/all')
    // Exactly the fields lab271_artnet.py's ColorRequest declares.
    expect(Object.keys(body).sort()).toEqual(['b', 'brightness', 'g', 'r', 'transition_ms'])
    for (const k of ['r', 'g', 'b']) {
      expect(Number.isInteger(body[k])).toBe(true)
      expect(body[k]).toBeGreaterThanOrEqual(0)
      expect(body[k]).toBeLessThanOrEqual(255)
    }
    expect(body.brightness).toBeGreaterThanOrEqual(0)
    expect(body.brightness).toBeLessThanOrEqual(1)
    expect(body.transition_ms).toBe(TRANSITION_MS)
  })

  it('caps brightness so a white screensaver cannot dazzle', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ maxBrightness: 0.4 }))
    sync.offerFrame(solid(255, 255, 255))
    await h.flush()
    expect(relay.calls[0].body.brightness).toBeLessThanOrEqual(0.4)
  })

  it('asks for a fade longer than the send interval, so sends glide', () => {
    // Otherwise consecutive sends step visibly instead of gliding.
    expect(TRANSITION_MS).toBeGreaterThan(SEND_INTERVAL_MS)
  })
})

describe('rate limiting', () => {
  it('sends at most once per interval however often it is offered', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    // 60Hz for a second.
    for (let i = 0; i < 60; i++) { sync.offerFrame(solid(255, 0, 0)); h.advance(16) }
    await h.flush()
    expect(relay.impl.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('sends again after the interval has passed', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    expect(relay.calls).toHaveLength(1)
    h.advance(SEND_INTERVAL_MS + 1)
    sync.offerFrame(solid(0, 255, 0))
    await h.flush()
    expect(relay.calls).toHaveLength(2)
  })

  it('does not overlap requests', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    let concurrent = 0, max = 0
    const impl = vi.fn(async () => {
      concurrent++; max = Math.max(max, concurrent)
      await gate
      concurrent--
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const { sync, h } = build({ impl, calls: [] })
    sync.offerFrame(solid(255, 0, 0))
    h.advance(SEND_INTERVAL_MS + 1)
    sync.offerFrame(solid(0, 255, 0))
    release()
    await h.flush()
    expect(max).toBe(1)
  })
})

describe('when the relay is unreachable', () => {
  it('never throws out of offerFrame', async () => {
    // This runs inside the screensaver's frame loop. A throw here would take the
    // wall down to keep a light in sync, which is exactly backwards.
    const relay = stubRelay({ fail: true })
    const { sync, h } = build(relay)
    expect(() => sync.offerFrame(solid(255, 0, 0))).not.toThrow()
    await h.flush()
    expect(sync.getStatus().failures).toBe(1)
  })

  it('backs off instead of retrying every second', async () => {
    const relay = stubRelay({ fail: true })
    const { sync, h } = build(relay)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    const afterFirst = relay.impl.mock.calls.length

    // A second later it would normally send again; backoff should hold it.
    h.advance(SEND_INTERVAL_MS + 1)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    expect(relay.impl.mock.calls.length).toBe(afterFirst)

    // Past the backoff window it tries once more.
    h.advance(10_000)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    expect(relay.impl.mock.calls.length).toBe(afterFirst + 1)
  })

  it('treats an HTTP error as a failure', async () => {
    for (const status of [404, 500, 503]) {
      const relay = stubRelay({ status })
      const { sync, h } = build(relay)
      sync.offerFrame(solid(255, 0, 0))
      await h.flush()
      expect(sync.getStatus().failures, `status ${status}`).toBe(1)
    }
  })

  it('recovers and resets the backoff', async () => {
    let failing = true
    const impl = vi.fn(async () => {
      if (failing) throw new Error('down')
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const { sync, h } = build({ impl, calls: [] })
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    expect(sync.getStatus().failures).toBe(1)

    failing = false
    h.advance(10 * 60 * 1000)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    expect(sync.getStatus().failures).toBe(0)
  })

  it('keeps a fixed-size status through a long outage', async () => {
    const relay = stubRelay({ fail: true })
    const { sync, h } = build(relay)
    for (let i = 0; i < 200; i++) {
      h.advance(10 * 60 * 1000)
      sync.offerFrame(solid(255, 0, 0))
      await h.flush()
    }
    expect(Object.keys(sync.getStatus()).sort()).toEqual(
      ['failures', 'lastColour', 'lastError', 'nextEligibleAt', 'sent'])
  })

  it('leaves no timer pending once requests have settled', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    sync.offerFrame(solid(255, 0, 0))
    await h.flush()
    // The only timer is the request-abort guard, cleared in the finally block.
    expect(h.pending()).toBe(0)
  })
})
