// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Art-Net spot mode: steering a field effect from the picture.
 *
 * Three things here are worth more than the arithmetic.
 *
 * **The y flip.** The sample grid comes from gl.readPixels, whose origin is the
 * bottom-left, so the grid's first row is the bottom of the screen. Get this
 * wrong and the room is lit upside-down -- which, in a room, looks like the
 * fixtures are miswired rather than like a sign error in a centroid.
 *
 * **Start once, nudge after.** Re-POSTing /effects/spot every second would reset
 * the effect's animation phase on the relay and read as a stutter. The first
 * send starts it; the rest are partial /field/params updates.
 *
 * **Effects do not stop by themselves.** A flat colour left alone is static; an
 * effect left alone keeps running after the wall wakes up, with nobody driving
 * it. So an effect we started is an effect we stop.
 *
 * The real fixtures are untouched: everything goes through the injected
 * transport. Checking the lights actually move belongs to someone in the room.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createArtnetSync,
  luminanceFocus,
  spotDiameter,
  effectNameFor,
  effectEndpoint,
  fieldParamsEndpoint,
  stopEndpoint,
  SPOT_DIAMETER_MIN,
  SPOT_DIAMETER_MAX,
  SPOT_SOFTNESS,
  DEFAULT_SPOT_DEPTH,
  SEND_INTERVAL_MS
} from '../src/renderer/screensavers/artnet-sync.js'
import { SAMPLE_GRID } from '../src/renderer/screensavers/gl-base.js'

const { tile, tilesX, tilesY } = SAMPLE_GRID
const PER_TILE = tile * tile * 4

/** Build a sample-grid buffer, colouring tiles via fn(tx, ty) -> [r,g,b]. */
function grid(fn) {
  const buf = new Uint8Array(tilesX * tilesY * PER_TILE)
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const [r, g, b] = fn(tx, ty) || [0, 0, 0]
      const base = (ty * tilesX + tx) * PER_TILE
      for (let i = base; i < base + PER_TILE; i += 4) {
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255
      }
    }
  }
  return buf
}

/** One lit tile, everything else black. */
const oneTile = (atX, atY, rgb = [255, 255, 255]) =>
  grid((tx, ty) => (tx === atX && ty === atY ? rgb : [0, 0, 0]))

function harness() {
  let clock = 1_700_000_000_000
  return {
    now: () => clock,
    advance(ms) { clock += ms },
    setTimer: () => 1,
    clearTimer: () => {},
    async flush(n = 20) { for (let i = 0; i < n; i++) await Promise.resolve() }
  }
}

function stubRelay({ fail = false } = {}) {
  const calls = []
  const impl = vi.fn(async (url, init) => {
    if (fail) throw new TypeError('Failed to fetch')
    calls.push({ url, body: JSON.parse(init?.body || '{}') })
    return { ok: true, status: 200 }
  })
  return { impl, calls }
}

const config = (over = {}) => () => ({
  enabled: true, url: 'http://pi.labs:8000', target: 'effect:spot',
  releaseScene: '', maxBrightness: 1, ...over
})

function build(relay, cfg = config(), h = harness()) {
  const sync = createArtnetSync({
    getConfig: cfg, fetchImpl: relay.impl,
    now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer
  })
  return { sync, h }
}

/** Drive one send and wait for the transport to settle. */
async function send(sync, h, frame) {
  sync.offerFrame(frame)
  await h.flush()
  h.advance(SEND_INTERVAL_MS)
}

describe('luminanceFocus', () => {
  it('flips y: the grid’s first row is the BOTTOM of the screen', () => {
    // ty = 0 is what readPixels returns first, i.e. the bottom of the picture.
    const bottom = luminanceFocus(oneTile(3, 0))
    const top = luminanceFocus(oneTile(3, tilesY - 1))
    expect(bottom.cy).toBeGreaterThan(0.5)
    expect(top.cy).toBeLessThan(0.5)
    // And specifically the outermost row centres, not merely "some" flip.
    expect(bottom.cy).toBeCloseTo(1 - 0.5 / tilesY, 5)
    expect(top.cy).toBeCloseTo(0.5 / tilesY, 5)
  })

  it('puts cx at the lit column', () => {
    expect(luminanceFocus(oneTile(0, 1)).cx).toBeCloseTo(0.5 / tilesX, 5)
    expect(luminanceFocus(oneTile(tilesX - 1, 1)).cx).toBeCloseTo(1 - 0.5 / tilesX, 5)
    expect(luminanceFocus(oneTile(3, 1)).cx).toBeCloseTo(3.5 / tilesX, 5)
  })

  it('weights tiles by luminance SQUARED, not linearly', () => {
    // Two lit tiles at the outer columns: white at fx = 1/16, mid-grey at
    // fx = 15/16. The expected centroid is worked out by hand so this pins the
    // weighting law rather than restating it:
    //   w_white = 1, w_grey = (128/255)^2 = 0.251965
    //   cx = (1/16 + 15/16 * 0.251965) / 1.251965 = 0.2386
    // Linear weighting would give w_grey = 0.50196 and cx = 0.3549. Squaring is
    // what lets one bright accent outvote a larger dim area, so the gap between
    // those two numbers is the whole point of the test.
    const f = luminanceFocus(grid((tx, ty) => {
      if (ty !== 1) return [0, 0, 0]
      if (tx === 0) return [255, 255, 255]
      if (tx === tilesX - 1) return [128, 128, 128]
      return [0, 0, 0]
    }))
    expect(f.cx).toBeCloseTo(0.2386, 3)
  })

  it('reads a full-frame wash as spread and a point source as concentrated', () => {
    expect(luminanceFocus(grid(() => [255, 255, 255])).spread).toBeGreaterThan(0.9)
    expect(luminanceFocus(oneTile(4, 2)).spread).toBeLessThan(0.05)
  })

  it('centres and widens on a black frame instead of drifting on float noise', () => {
    const f = luminanceFocus(grid(() => [0, 0, 0]))
    expect(f).toMatchObject({ cx: 0.5, cy: 0.5, spread: 1, weight: 0 })
  })

  it('ignores a short buffer instead of reading past the end', () => {
    const short = new Uint8Array(PER_TILE * 3)
    short.fill(255)
    expect(() => luminanceFocus(short)).not.toThrow()
    expect(Number.isFinite(luminanceFocus(short).cx)).toBe(true)
  })
})

describe('spotDiameter', () => {
  it('maps spread onto the configured range, clamped', () => {
    expect(spotDiameter(0)).toBeCloseTo(SPOT_DIAMETER_MIN, 6)
    expect(spotDiameter(1)).toBeCloseTo(SPOT_DIAMETER_MAX, 6)
    expect(spotDiameter(-5)).toBeCloseTo(SPOT_DIAMETER_MIN, 6)
    expect(spotDiameter(5)).toBeCloseTo(SPOT_DIAMETER_MAX, 6)
    expect(spotDiameter(0.5)).toBeGreaterThan(spotDiameter(0.25))
  })
})

describe('effectNameFor', () => {
  it('recognises effect targets only', () => {
    expect(effectNameFor('effect:spot')).toBe('spot')
    expect(effectNameFor('  effect:aurora  ')).toBe('aurora')
    expect(effectNameFor('all')).toBeNull()
    expect(effectNameFor('group:universe_0')).toBeNull()
    expect(effectNameFor('strip:u0_01')).toBeNull()
    expect(effectNameFor('effect:')).toBeNull()
    expect(effectNameFor('')).toBeNull()
    expect(effectNameFor(undefined)).toBeNull()
  })
})

describe('endpoints', () => {
  it('builds effect, field and stop paths and tolerates a trailing slash', () => {
    expect(effectEndpoint('http://pi:8000/', 'spot')).toBe('http://pi:8000/effects/spot')
    expect(fieldParamsEndpoint('http://pi:8000//')).toBe('http://pi:8000/field/params')
    expect(stopEndpoint('http://pi:8000')).toBe('http://pi:8000/stop')
  })

  it('encodes a name rather than splicing it into the path', () => {
    expect(effectEndpoint('http://pi:8000', 'a/b')).toBe('http://pi:8000/effects/a%2Fb')
  })
})

describe('spot mode sends', () => {
  it('starts the effect once, then only nudges the field', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)

    await send(sync, h, oneTile(1, 1))
    await send(sync, h, oneTile(6, 1))
    await send(sync, h, oneTile(4, 1))

    expect(relay.calls).toHaveLength(3)
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/effects/spot')
    expect(relay.calls[1].url).toBe('http://pi.labs:8000/field/params')
    expect(relay.calls[2].url).toBe('http://pi.labs:8000/field/params')

    // Start is a flat EffectRequest; the nudges are wrapped in `params`.
    expect(relay.calls[0].body.cx).toBeCloseTo(1.5 / tilesX, 5)
    expect(relay.calls[0].body.params).toBeUndefined()
    expect(relay.calls[1].body.params.cx).toBeCloseTo(6.5 / tilesX, 5)
  })

  it('moves cx with the picture and holds cy at the configured depth', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ spotDepth: 0.2 }))

    await send(sync, h, oneTile(0, 0))
    await send(sync, h, oneTile(tilesX - 1, tilesY - 1))

    const [start, nudge] = relay.calls
    expect(start.body.cy).toBeCloseTo(0.2, 6)
    // Depth is a setting, so a frame whose light moved vertically must not move
    // cy -- that mapping would be invented.
    expect(nudge.body.params.cy).toBeCloseTo(0.2, 6)
    expect(nudge.body.params.cx).toBeGreaterThan(start.body.cx)
  })

  it('clamps a depth outside the room to its walls', async () => {
    // The field is normalised 0..1; a cy of 5 would place the spot outside the
    // room, where the relay's behaviour is not worth guessing at.
    const far = stubRelay()
    const a = build(far, config({ spotDepth: 5 }))
    await send(a.sync, a.h, oneTile(2, 2))
    expect(far.calls[0].body.cy).toBe(1)

    const near = stubRelay()
    const b = build(near, config({ spotDepth: -3 }))
    await send(b.sync, b.h, oneTile(2, 2))
    expect(near.calls[0].body.cy).toBe(0)
  })

  it('defaults depth to the middle of the room', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ spotDepth: undefined }))
    await send(sync, h, oneTile(2, 2))
    expect(relay.calls[0].body.cy).toBeCloseTo(DEFAULT_SPOT_DEPTH, 6)
  })

  it('pre-multiplies brightness into rgb, because spot has no brightness param', async () => {
    const relayFull = stubRelay()
    const full = build(relayFull, config({ maxBrightness: 1 }))
    await send(full.sync, full.h, grid(() => [255, 255, 255]))

    const relayDim = stubRelay()
    const dim = build(relayDim, config({ maxBrightness: 0.25 }))
    await send(dim.sync, dim.h, grid(() => [255, 255, 255]))

    const a = relayFull.calls[0].body
    const b = relayDim.calls[0].body
    expect(b.r).toBeLessThan(a.r)
    expect(b.r / a.r).toBeCloseTo(0.25, 1)
    // A `brightness` key would be silently dropped by the relay, so maxBrightness
    // has to land in the channels or it stops working without any error.
    expect(a.brightness).toBeUndefined()
    expect(b.brightness).toBeUndefined()
  })

  it('sends the shape the effect actually takes', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await send(sync, h, oneTile(3, 1, [255, 40, 40]))
    const body = relay.calls[0].body
    expect(Object.keys(body).sort()).toEqual(
      ['b', 'cx', 'cy', 'diameter', 'g', 'r', 'softness'])
    expect(body.softness).toBeCloseTo(SPOT_SOFTNESS, 6)
    for (const k of ['r', 'g', 'b']) {
      expect(Number.isInteger(body[k])).toBe(true)
      expect(body[k]).toBeGreaterThanOrEqual(0)
      expect(body[k]).toBeLessThanOrEqual(255)
    }
    expect(body.diameter).toBeGreaterThanOrEqual(SPOT_DIAMETER_MIN)
    expect(body.diameter).toBeLessThanOrEqual(SPOT_DIAMETER_MAX)
  })

  it('rounds field values instead of shipping float-division noise', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    // A full-frame wash is the case that produces the noise: the centroid of a
    // uniform grid comes out as 0.5000000000000001 and the diameter as
    // 0.7951371798225177 -- three times the JSON for precision no fixture can
    // render. A single lit tile would land on 0.4375 and prove nothing.
    await send(sync, h, grid(() => [200, 90, 30]))
    const body = relay.calls[0].body
    expect(body.cx).toBe(0.5)
    expect(body.diameter).toBe(0.7951)
    for (const k of ['cx', 'cy', 'diameter']) {
      const decimals = String(body[k]).split('.')[1] || ''
      expect(decimals.length).toBeLessThanOrEqual(4)
    }
  })

  it('restarts the effect after a failed send rather than nudging a dead field', async () => {
    const relay = stubRelay({ fail: true })
    const { sync, h } = build(relay)
    await send(sync, h, oneTile(1, 1))
    expect(sync.getStatus().effectRunning).toBe(false)

    // Past the backoff, the next send must start the effect again -- a
    // /field/params post would target a field that is not running.
    h.advance(10 * 60 * 1000)
    const ok = stubRelay()
    const second = build(ok, config(), h)
    await send(second.sync, h, oneTile(1, 1))
    expect(ok.calls[0].url).toBe('http://pi.labs:8000/effects/spot')
  })

  it('leaves colour targets on the flat-colour path', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ target: 'all' }))
    await send(sync, h, grid(() => [255, 255, 255]))
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/all')
    expect(relay.calls[0].body).toHaveProperty('brightness')
    expect(relay.calls[0].body).toHaveProperty('transition_ms')
    expect(relay.calls[0].body.cx).toBeUndefined()
  })
})

describe('spot mode release', () => {
  it('stops an effect it started, so the room does not pulse forever', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await send(sync, h, oneTile(2, 1))
    relay.calls.length = 0

    sync.release()
    await h.flush()
    expect(relay.calls).toHaveLength(1)
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/stop')
    expect(sync.getStatus().effectRunning).toBe(false)
  })

  it('sends nothing when it never started an effect', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    sync.release()
    await h.flush()
    expect(relay.calls).toHaveLength(0)
  })

  it('prefers a configured release scene over stopping', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ releaseScene: 'warm_wit' }))
    await send(sync, h, oneTile(2, 1))
    relay.calls.length = 0

    sync.release()
    await h.flush()
    expect(relay.calls).toHaveLength(1)
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/scenes/warm_wit')
  })

  it('still sends nothing at all when disabled', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ enabled: false }))
    await send(sync, h, oneTile(2, 1))
    sync.release()
    await h.flush()
    expect(relay.calls).toHaveLength(0)
  })

  it('does not leave the effect marked running after release', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await send(sync, h, oneTile(2, 1))
    sync.release()
    await h.flush()
    relay.calls.length = 0

    // Next activation must start the effect, not nudge a stopped field.
    await send(sync, h, oneTile(2, 1))
    expect(relay.calls[0].url).toBe('http://pi.labs:8000/effects/spot')
  })
})
