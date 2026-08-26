// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Spatial mode: the wall's colours on the fixtures nearest them.
 *
 * Four things here are load-bearing, and none of them is the averaging.
 *
 * **Wiring direction.** A strip's `angle` shows up in the layout as x1 > x2, and
 * pixel 1 belongs at x1. Interpolating from min to max instead would mirror the
 * gradient on half the rig -- which, standing in the room, reads as a strip wired
 * backwards rather than as a bug in here.
 *
 * **The strips' extent, not the room's.** This rig spans x 1.5..10.5 of a 12 m
 * room. Normalising against the room width would map the outer eighth of the
 * picture at each side onto bare floor, where nobody would ever see it.
 *
 * **The write cap.** There is no bulk endpoint, so 40 strips is 40 POSTs. This
 * app has already cost the wall a 40x slowdown once by being casual about
 * per-frame work, so the cap is not a nicety.
 *
 * **Luminance weighting.** Most screensavers are mostly black. A flat mean down a
 * column pulls every column toward black and leaves the room a uniform dim wash
 * -- exactly what this feature exists to avoid.
 *
 * Geometry below is taken from the real rig's GET /layout.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createArtnetSync,
  columnProfile,
  sampleProfile,
  stripExtent,
  stripGradient,
  spatialPlan,
  layoutEndpoint,
  stripPixelsEndpoint,
  modeForSaver,
  SPATIAL_MAX_WRITES,
  SPATIAL_CHANGE_THRESHOLD,
  SEND_INTERVAL_MS
} from '../src/renderer/screensavers/artnet-sync.js'
import { SAMPLE_GRID } from '../src/renderer/screensavers/gl-base.js'

const BASE = 'http://pi.labs:8000'
const { tile, tilesX, tilesY } = SAMPLE_GRID
const PER_TILE = tile * tile * 4

/** Real entries from the rig's layout, including both orientations. */
const LAYOUT_STRIPS = [
  { name: 'u0_01', pixels: 8, angle: 180, x: 6.0, y: 4.5, x1: 6.5, y1: 4.5, x2: 5.5, y2: 4.5 },
  { name: 'u0_02', pixels: 8, angle: 90, x: 6.5, y: 5.0, x1: 6.5, y1: 4.5, x2: 6.5, y2: 5.5 },
  { name: 'u0_05', pixels: 8, angle: 0, x: 5.0, y: 6.5, x1: 4.5, y1: 6.5, x2: 5.5, y2: 6.5 },
  { name: 'u1_01', pixels: 8, angle: 0, x: 1.5, y: 3.0, x1: 1.5, y1: 3.0, x2: 2.5, y2: 3.0 },
  { name: 'u4_08', pixels: 8, angle: 180, x: 10.5, y: 5.5, x1: 10.5, y1: 5.5, x2: 9.5, y2: 5.5 }
]
const EXTENT = { min: 1.5, max: 10.5 }

/** Build a grid buffer from a per-tile colour function. */
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

/** Green on the left half of the frame, red on the right. */
const splitFrame = () => grid((tx) => (tx < tilesX / 2 ? [0, 200, 0] : [200, 0, 0]))

function harness() {
  let clock = 1_700_000_000_000
  return {
    now: () => clock, advance(ms) { clock += ms },
    setTimer: () => 1, clearTimer: () => {},
    async flush(n = 60) { for (let i = 0; i < n; i++) await Promise.resolve() }
  }
}

function stubRelay({ layout = { strips: LAYOUT_STRIPS }, layoutFails = false,
  pixelsFail = false } = {}) {
  const calls = []
  const impl = vi.fn(async (url, init) => {
    const method = init?.method || 'POST'
    if (method === 'GET') {
      calls.push({ url, method: 'GET' })
      if (url.endsWith('/layout')) {
        if (layoutFails) throw new TypeError('Failed to fetch')
        return { ok: true, status: 200, json: async () => layout }
      }
      return { ok: true, status: 200, json: async () => ({ strips: [{ name: 'a', rgb: [0, 0, 0], brightness: 1 }] }) }
    }
    calls.push({ url, method: 'POST', body: JSON.parse(init?.body || '{}') })
    if (pixelsFail && url.endsWith('/pixels')) return { ok: false, status: 500 }
    return { ok: true, status: 200 }
  })
  return { impl, calls, posts: () => calls.filter(c => c.method === 'POST') }
}

const config = (over = {}) => () => ({
  enabled: true, url: BASE, target: 'all', releaseScene: '',
  maxBrightness: 0.8, spotDepth: 0.5, sceneBySaver: { a: 'spatial' }, ...over
})

function build(relay, cfgFn = config(), h = harness()) {
  return {
    sync: createArtnetSync({
      getConfig: cfgFn, fetchImpl: relay.impl,
      now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer
    }),
    h
  }
}

describe('columnProfile', () => {
  it('keeps left and right colours apart instead of averaging them', () => {
    const p = columnProfile(splitFrame())
    expect(p).toHaveLength(tilesX)
    expect(p[0].g).toBeGreaterThan(150)
    expect(p[0].r).toBeLessThan(40)
    expect(p[tilesX - 1].r).toBeGreaterThan(150)
    expect(p[tilesX - 1].g).toBeLessThan(40)
  })

  it('weights by luminance, so one bright tile is not lost down a dark column', () => {
    // One lit tile in a column of four. A flat mean would divide it by four and
    // leave the room a dim wash; weighting keeps the colour it actually shows.
    const p = columnProfile(grid((tx, ty) => (tx === 2 && ty === 1 ? [0, 255, 0] : [0, 0, 0])))
    expect(p[2].g).toBeGreaterThan(200)
  })

  it('returns black for a black frame rather than dividing by zero', () => {
    const p = columnProfile(grid(() => [0, 0, 0]))
    expect(p.every(c => c.r === 0 && c.g === 0 && c.b === 0)).toBe(true)
  })

  it('survives a short buffer', () => {
    const short = new Uint8Array(PER_TILE * 3)
    short.fill(200)
    expect(() => columnProfile(short)).not.toThrow()
    expect(columnProfile(short)).toHaveLength(tilesX)
  })
})

describe('sampleProfile', () => {
  const ramp = [{ r: 0, g: 0, b: 0 }, { r: 100, g: 100, b: 100 }, { r: 200, g: 200, b: 200 }]

  it('interpolates between columns rather than stepping', () => {
    // Column centres are at 1/6, 3/6, 5/6 for three columns. Halfway between the
    // first two centres is 2/6, and should read halfway between their values.
    expect(sampleProfile(ramp, 2 / 6).r).toBeCloseTo(50, 0)
  })

  it('lands exactly on a column at its centre', () => {
    expect(sampleProfile(ramp, 1 / 6).r).toBe(0)
    expect(sampleProfile(ramp, 3 / 6).r).toBe(100)
    expect(sampleProfile(ramp, 5 / 6).r).toBe(200)
  })

  it('holds the end colour outside the outer centres, and clamps', () => {
    expect(sampleProfile(ramp, 0).r).toBe(0)
    expect(sampleProfile(ramp, 1).r).toBe(200)
    expect(sampleProfile(ramp, -3).r).toBe(0)
    expect(sampleProfile(ramp, 9).r).toBe(200)
  })

  it('returns black for an empty profile', () => {
    expect(sampleProfile([], 0.5)).toEqual({ r: 0, g: 0, b: 0 })
  })
})

describe('stripExtent', () => {
  it('measures the span the fixtures occupy, not the room', () => {
    expect(stripExtent(LAYOUT_STRIPS)).toEqual({ min: 1.5, max: 10.5 })
  })

  it('returns null when there is nothing usable to normalise against', () => {
    expect(stripExtent([])).toBeNull()
    expect(stripExtent(null)).toBeNull()
    expect(stripExtent([{ name: 'a' }])).toBeNull()
    // Every strip at one x: a span of zero would divide by zero downstream.
    expect(stripExtent([{ x1: 4, x2: 4 }, { x1: 4, x2: 4 }])).toBeNull()
  })

  it('ignores non-numeric coordinates', () => {
    expect(stripExtent([{ x1: 'nope', x2: 3 }, { x1: 7, x2: null }]))
      .toEqual({ min: 3, max: 7 })
  })
})

describe('stripGradient', () => {
  it('respects the wiring direction, so pixel 1 sits at x1', () => {
    // u0_01 runs right-to-left (angle 180, x1 6.5 > x2 5.5). On a green-left,
    // red-right frame its pixel 1 must be the redder end. Interpolating min->max
    // would mirror this strip and half the rig with it.
    const profile = columnProfile(splitFrame())
    const px = stripGradient(LAYOUT_STRIPS[0], profile, EXTENT)
    expect(px).toHaveLength(8)
    expect(px[0][0]).toBeGreaterThan(px[7][0])   // pixel 1 redder
    expect(px[7][1]).toBeGreaterThan(px[0][1])   // pixel 8 greener
  })

  it('runs the other way for a strip wired the other way', () => {
    // The mirror of u0_01: same 5.5..6.5 span, wired left-to-right. It has to
    // straddle the frame's colour boundary (room x 6.0 for this extent) or there
    // is no gradient to have a direction -- u0_05 sits wholly in the green half
    // and would pass this test with the interpolation reversed.
    const mirror = { name: 'mirror', pixels: 8, x1: 5.5, x2: 6.5 }
    const px = stripGradient(mirror, columnProfile(splitFrame()), EXTENT)
    expect(px[7][0]).toBeGreaterThan(px[0][0])   // pixel 8 redder
    expect(px[0][1]).toBeGreaterThan(px[7][1])   // pixel 1 greener

    // And it is genuinely the reverse of the strip wired the other way.
    const forward = stripGradient(LAYOUT_STRIPS[0], columnProfile(splitFrame()), EXTENT)
    expect(px.map(c => c.join(','))).toEqual([...forward].reverse().map(c => c.join(',')))
  })

  it('gives a vertical strip one flat colour', () => {
    // u0_02 stands in y: every pixel is at the same room x, so there is no
    // horizontal variation to show.
    const px = stripGradient(LAYOUT_STRIPS[1], columnProfile(splitFrame()), EXTENT)
    expect(new Set(px.map(p => p.join(','))).size).toBe(1)
  })

  it('picks up the colour above where the strip actually is', () => {
    const profile = columnProfile(splitFrame())
    const left = stripGradient(LAYOUT_STRIPS[3], profile, EXTENT)   // x 1.5-2.5
    const right = stripGradient(LAYOUT_STRIPS[4], profile, EXTENT)  // x 9.5-10.5
    expect(left.every(p => p[1] > p[0])).toBe(true)   // green end of the room
    expect(right.every(p => p[0] > p[1])).toBe(true)  // red end
  })

  it('emits one entry per pixel, as integers in range', () => {
    for (const st of LAYOUT_STRIPS) {
      const px = stripGradient(st, columnProfile(splitFrame()), EXTENT)
      expect(px).toHaveLength(st.pixels)
      for (const p of px) {
        expect(p).toHaveLength(3)
        for (const c of p) {
          expect(Number.isInteger(c)).toBe(true)
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(255)
        }
      }
    }
  })

  it('handles a single-pixel strip', () => {
    const px = stripGradient({ name: 'x', pixels: 1, x1: 6, x2: 6 },
      columnProfile(splitFrame()), EXTENT)
    expect(px).toHaveLength(1)
  })
})

describe('spatialPlan', () => {
  const profile = () => columnProfile(splitFrame())

  it('writes everything the first time round', () => {
    const plan = spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map())
    expect(plan).toHaveLength(LAYOUT_STRIPS.length)
  })

  it('skips strips whose colour has not moved', () => {
    const seen = new Map()
    for (const item of spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map())) {
      seen.set(item.name, item.pixels)
    }
    // Same frame again: nothing has changed, so nothing should be sent. This is
    // what lets a near-static screensaver stop consuming the budget entirely.
    expect(spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, seen)).toHaveLength(0)
  })

  it('never exceeds the write cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `s${String(i).padStart(2, '0')}`, pixels: 8,
      x1: 1.5 + i * 0.22, x2: 1.5 + i * 0.22 + 0.5
    }))
    const plan = spatialPlan(many, profile(), EXTENT, new Map())
    expect(plan).toHaveLength(SPATIAL_MAX_WRITES)
    expect(plan.length).toBeLessThan(many.length)
  })

  it('spends the budget on the strips that moved most', () => {
    const seen = new Map()
    for (const item of spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map())) {
      seen.set(item.name, item.pixels)
    }
    const flipped = columnProfile(grid((tx) => (tx < tilesX / 2 ? [200, 0, 0] : [0, 200, 0])))
    const all = spatialPlan(LAYOUT_STRIPS, flipped, EXTENT, seen, 99)
    const capped = spatialPlan(LAYOUT_STRIPS, flipped, EXTENT, seen, 2)

    // The property, not a name list: several strips tie at the maximum change
    // here, so naming two would pin the tie-break rather than the priority.
    expect(capped).toHaveLength(2)
    const chosen = Math.min(...capped.map(p => p.change))
    const dropped = all.slice(2).map(p => p.change)
    for (const d of dropped) expect(chosen).toBeGreaterThanOrEqual(d)
    // And ordering is monotonic, so the cap always takes from the top.
    expect(all.map(p => p.change)).toEqual([...all.map(p => p.change)].sort((a, b) => b - a))
  })

  it('honours the change threshold', () => {
    const seen = new Map()
    for (const item of spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map())) {
      seen.set(item.name, item.pixels)
    }
    // A shift smaller than the threshold must not trigger a rewrite.
    const nudged = profile().map(c => ({ ...c, r: c.r + SPATIAL_CHANGE_THRESHOLD - 2 }))
    expect(spatialPlan(LAYOUT_STRIPS, nudged, EXTENT, seen)).toHaveLength(0)
    const shoved = profile().map(c => ({ ...c, r: Math.min(255, c.r + SPATIAL_CHANGE_THRESHOLD + 20) }))
    expect(spatialPlan(LAYOUT_STRIPS, shoved, EXTENT, seen).length).toBeGreaterThan(0)
  })

  it('is deterministic when changes tie', () => {
    const a = spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map()).map(p => p.name)
    const b = spatialPlan(LAYOUT_STRIPS, profile(), EXTENT, new Map()).map(p => p.name)
    expect(a).toEqual(b)
  })

  it('ignores entries without a name', () => {
    const plan = spatialPlan([...LAYOUT_STRIPS, { pixels: 8, x1: 3, x2: 4 }, null],
      profile(), EXTENT, new Map())
    expect(plan.every(p => typeof p.name === 'string')).toBe(true)
  })
})

describe('the client in spatial mode', () => {
  const spatialFrame = () => splitFrame()

  it('reads the layout once, then writes pixels', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(spatialFrame())
    await h.flush()
    const layoutReads = relay.calls.filter(c => c.url === layoutEndpoint(BASE))
    expect(layoutReads).toHaveLength(1)
    expect(relay.posts()[0].url).toBe(stripPixelsEndpoint(BASE, 'u0_01'))
  })

  it('does not re-read the layout on later frames', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await sync.activate('a')
    for (let i = 0; i < 3; i++) {
      sync.offerFrame(spatialFrame())
      await h.flush()
      h.advance(SEND_INTERVAL_MS)
    }
    expect(relay.calls.filter(c => c.url === layoutEndpoint(BASE))).toHaveLength(1)
  })

  it('sends the pixel array, brightness and a transition', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0
    sync.offerFrame(spatialFrame())
    await h.flush()

    const body = relay.posts()[0].body
    expect(Array.isArray(body.pixels)).toBe(true)
    expect(body.pixels).toHaveLength(8)
    expect(body.pixels[0]).toHaveLength(3)
    expect(body.brightness).toBe(0.8)
    expect(body.transition_ms).toBeGreaterThan(0)
  })

  it('stops writing once the picture settles', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await sync.activate('a')
    sync.offerFrame(spatialFrame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    relay.calls.length = 0

    sync.offerFrame(spatialFrame())
    await h.flush()
    expect(relay.posts()).toHaveLength(0)
  })

  it('gives up on a layout it cannot read, rather than asking every second', async () => {
    const relay = stubRelay({ layoutFails: true })
    const { sync, h } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    for (let i = 0; i < 4; i++) {
      sync.offerFrame(spatialFrame())
      await h.flush()
      h.advance(SEND_INTERVAL_MS)
    }
    expect(relay.calls.filter(c => c.url === layoutEndpoint(BASE))).toHaveLength(1)
    expect(relay.posts()).toHaveLength(0)
  })

  it('gives up on a layout with no usable geometry', async () => {
    const relay = stubRelay({ layout: { strips: [{ name: 'a' }] } })
    const { sync, h } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0
    sync.offerFrame(spatialFrame())
    await h.flush()
    expect(relay.posts()).toHaveLength(0)
  })

  it('forgets what it wrote on release', async () => {
    // Otherwise the next activation would think the strips already hold this
    // frame's colours and skip them all as unchanged, leaving the room dark.
    const relay = stubRelay()
    const { sync, h } = build(relay)
    await sync.activate('a')
    sync.offerFrame(spatialFrame())
    await h.flush()
    await sync.release()
    relay.calls.length = 0

    await sync.activate('a')
    // Past the 1Hz gate: it is shared across activations, so without this the
    // frame below is dropped by the rate limit and proves nothing either way.
    h.advance(SEND_INTERVAL_MS)
    sync.offerFrame(spatialFrame())
    await h.flush()
    expect(relay.posts().length).toBeGreaterThan(0)
  })

  it('retries a strip whose write failed instead of assuming it landed', async () => {
    // Recording a failed write as the strip's current colour would leave that
    // strip stuck on whatever it happened to be showing, permanently skipped as
    // "unchanged" while every other strip tracked the wall.
    const relay = stubRelay({ pixelsFail: true })
    const { sync, h } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(spatialFrame())
    await h.flush()
    const first = relay.posts().map(c => c.url)
    // Stops at the first failure rather than hammering a relay that is refusing.
    expect(first).toHaveLength(1)

    // Past the failure backoff, not just the send interval: a failed write also
    // engages the 5s backoff, which is the behaviour that stops a dead relay
    // being retried every second for days.
    h.advance(10_000)
    relay.calls.length = 0
    sync.offerFrame(spatialFrame())
    await h.flush()
    expect(relay.posts().map(c => c.url)).toEqual(first)
  })

  it('is selectable as a global target as well as per saver', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ target: 'spatial', sceneBySaver: {} }))
    await sync.activate('z')
    relay.calls.length = 0
    sync.offerFrame(spatialFrame())
    await h.flush()
    expect(relay.posts()[0].url).toContain('/pixels')
  })

  it('is recognised by modeForSaver', () => {
    expect(modeForSaver('a', { a: 'spatial' })).toEqual({ kind: 'spatial', name: '' })
  })
})
