// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Per-effect parameters.
 *
 * Every effect on the relay declares its own parameter set, and the relay
 * ignores anything it does not recognise -- silently, with a 200. 3.1.0 sent the
 * spot's shape to whichever effect was configured, so `effect:plasma`, which
 * takes scale/speed/brightness and no colour at all, received seven keys it had
 * no use for and ran at its defaults forever. It looked wired up and was not,
 * and nothing anywhere failed.
 *
 * So the contract worth testing is narrow and exact: **each effect receives only
 * keys it declares, and receives the ones that make it respond to the picture.**
 * The declared sets are pinned here from the live GET /effects, which is the
 * source of truth the code cannot check for itself.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createArtnetSync,
  effectDriver,
  EFFECT_DRIVERS,
  DEFAULT_SAVER_MODES,
  modeForSaver,
  SEND_INTERVAL_MS
} from '../src/renderer/screensavers/artnet-sync.js'

const BASE = 'http://pi.labs:8000'

/**
 * Parameters each effect accepts, read from the live relay's GET /effects.
 *
 * Hardcoded deliberately: this is the external contract, so a copy here is what
 * makes a drift in our own table detectable. If the relay gains a parameter this
 * list is what needs updating first.
 */
const DECLARED = {
  spot: ['r', 'g', 'b', 'cx', 'cy', 'diameter', 'softness'],
  ripple: ['r', 'g', 'b', 'speed', 'wavelength', 'cx', 'cy'],
  plasma: ['scale', 'speed', 'brightness'],
  blobs: ['r', 'g', 'b', 'speed', 'size', 'count'],
  tunnel: ['speed', 'rings', 'arms', 'brightness'],
  sweep: ['r', 'g', 'b', 'speed', 'direction', 'width'],
  aurora: ['speed', 'scale', 'brightness']
}

/** Effects the relay reports as field-based, i.e. nudgeable via /field/params. */
const FIELD_EFFECTS = ['spot', 'ripple', 'plasma', 'blobs', 'tunnel', 'sweep', 'aurora']

/** Effects that exist but take no steering from us. */
const NON_FIELD = ['rainbow', 'chase', 'breathe', 'strobe', 'police', 'fire',
  'sparkle', 'wave', 'comet', 'snake']

const col = { r: 200, g: 90, b: 30 }
const focus = { cx: 0.4, cy: 0.5, spread: 0.5, weight: 0.5 }
const cfg = { spotDepth: 0.5 }

function harness() {
  let clock = 1_700_000_000_000
  return {
    now: () => clock, advance(ms) { clock += ms },
    setTimer: () => 1, clearTimer: () => {},
    async flush(n = 30) { for (let i = 0; i < n; i++) await Promise.resolve() }
  }
}

function stubRelay() {
  const calls = []
  const impl = vi.fn(async (url, init) => {
    const method = init?.method || 'POST'
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ strips: [{ name: 'a', rgb: [0, 0, 0], brightness: 1 }] }) }
    calls.push({ url, body: JSON.parse(init?.body || '{}') })
    return { ok: true, status: 200 }
  })
  return { impl, calls }
}

const config = (over = {}) => () => ({
  enabled: true, url: BASE, target: 'all', releaseScene: '',
  maxBrightness: 1, spotDepth: 0.5, sceneBySaver: {}, ...over
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

const frame = () => {
  const buf = new Uint8Array(8 * 8 * 8 * 4 * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 200; buf[i + 1] = 90; buf[i + 2] = 30; buf[i + 3] = 255
  }
  return buf
}

describe('every driven effect sends only what it declares', () => {
  for (const [name, declared] of Object.entries(DECLARED)) {
    it(`${name} sends a subset of its declared parameters`, () => {
      const d = effectDriver(name, col, focus, 0.7, cfg)
      expect(d, `${name} has no driver`).not.toBeNull()
      const extra = Object.keys(d.params).filter(k => !declared.includes(k))
      expect(extra, `${name} sent undeclared keys`).toEqual([])
    })

    it(`${name} sends something, so it is actually driven`, () => {
      const d = effectDriver(name, col, focus, 0.7, cfg)
      expect(Object.keys(d.params).length).toBeGreaterThan(0)
    })
  }

  it('marks exactly the relay’s field effects as nudgeable', () => {
    for (const name of Object.keys(EFFECT_DRIVERS)) {
      expect(FIELD_EFFECTS, `${name} is not a field effect on the relay`).toContain(name)
      expect(EFFECT_DRIVERS[name].field).toBe(true)
    }
  })

  it('does not claim to drive an effect it has no table entry for', () => {
    for (const name of NON_FIELD) {
      expect(effectDriver(name, col, focus, 0.7, cfg), name).toBeNull()
    }
  })
})

describe('plasma, the pairing that was silently broken', () => {
  it('sends scale/speed/brightness and NO colour', () => {
    const { params } = effectDriver('plasma', col, focus, 0.7, cfg)
    expect(Object.keys(params).sort()).toEqual(['brightness', 'scale', 'speed'])
    // The 3.1.0 bug: r/g/b were sent and silently discarded.
    for (const k of ['r', 'g', 'b', 'cx', 'cy', 'diameter', 'softness']) {
      expect(params[k], `plasma should not receive ${k}`).toBeUndefined()
    }
  })

  it('tracks the frame’s brightness, so the room follows the wall', () => {
    const dim = effectDriver('plasma', col, focus, 0.15, cfg).params
    const bright = effectDriver('plasma', col, focus, 0.95, cfg).params
    expect(bright.brightness).toBeGreaterThan(dim.brightness)
    expect(bright.speed).toBeGreaterThan(dim.speed)
  })

  it('takes its scale from how spread out the light is', () => {
    const tight = effectDriver('plasma', col, { ...focus, spread: 0 }, 0.5, cfg).params
    const wide = effectDriver('plasma', col, { ...focus, spread: 1 }, 0.5, cfg).params
    expect(wide.scale).toBeGreaterThan(tight.scale)
  })
})

describe('positional effects still track the picture', () => {
  it('spot and ripple both follow the luminance centroid', () => {
    const left = { ...focus, cx: 0.1 }
    const right = { ...focus, cx: 0.9 }
    for (const name of ['spot', 'ripple']) {
      const a = effectDriver(name, col, left, 0.5, cfg).params
      const b = effectDriver(name, col, right, 0.5, cfg).params
      expect(b.cx, name).toBeGreaterThan(a.cx)
    }
  })

  it('keeps colour on the effects that accept it', () => {
    for (const name of ['spot', 'ripple', 'blobs', 'sweep']) {
      const { params } = effectDriver(name, col, focus, 0.5, cfg)
      expect(params, name).toMatchObject({ r: 200, g: 90, b: 30 })
    }
  })

  it('omits colour from the effects that generate their own', () => {
    for (const name of ['plasma', 'aurora', 'tunnel']) {
      const { params } = effectDriver(name, col, focus, 0.5, cfg)
      expect(params.r, name).toBeUndefined()
    }
  })

  it('keeps integer-only parameters integral at every spread', () => {
    // count/rings/arms index discrete things on the relay; a float would either
    // be truncated somewhere unseen or rejected. Swept rather than sampled at
    // one value: spread 0.5 lands on a whole number by luck and proves nothing.
    for (const spread of [0, 0.1, 0.3, 0.4, 0.5, 0.7, 0.85, 1]) {
      const f = { ...focus, spread }
      const blobs = effectDriver('blobs', col, f, 0.5, cfg).params
      const tunnel = effectDriver('tunnel', col, f, 0.5, cfg).params
      expect(Number.isInteger(blobs.count), `blobs.count at ${spread}`).toBe(true)
      expect(Number.isInteger(tunnel.rings), `tunnel.rings at ${spread}`).toBe(true)
      expect(Number.isInteger(tunnel.arms), `tunnel.arms at ${spread}`).toBe(true)
    }
  })

  it('keeps every fractional parameter inside 0..1 where the relay expects it', () => {
    for (const spread of [0, 0.5, 1]) {
      for (const level of [0, 0.5, 1]) {
        for (const name of Object.keys(EFFECT_DRIVERS)) {
          const { params } = effectDriver(name, col, { ...focus, spread }, level, cfg)
          for (const k of ['cx', 'cy', 'diameter', 'softness', 'brightness', 'width', 'size']) {
            if (params[k] === undefined) continue
            expect(params[k], `${name}.${k} at spread ${spread} level ${level}`)
              .toBeGreaterThanOrEqual(0)
            expect(params[k], `${name}.${k} at spread ${spread} level ${level}`)
              .toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })
})

describe('default saver pairings', () => {
  it('pairs Plasma with the plasma effect', () => {
    expect(modeForSaver('Plasma', {})).toEqual({ kind: 'effect', name: 'plasma' })
  })

  it('pairs Metaballs with blobs and Wave Tank with ripple', () => {
    expect(modeForSaver('Metaballs', {})).toEqual({ kind: 'effect', name: 'blobs' })
    expect(modeForSaver('Wave Tank', {})).toEqual({ kind: 'effect', name: 'ripple' })
  })

  it('leaves every other saver reactive', () => {
    for (const s of ['Matrix Rain', 'Frost', 'Boids', 'Voronoi', 'DVD Logo']) {
      expect(modeForSaver(s, {}).kind, s).toBe('reactive')
    }
  })

  it('treats a present-but-empty entry as reactive, not as absent', () => {
    // A truthiness check would let '' fall through to the built-in pairing, so a
    // saver someone had deliberately cleared would start running an effect.
    for (const empty of ['', null, undefined]) {
      expect(modeForSaver('Plasma', { Plasma: empty }).kind, String(empty)).toBe('reactive')
    }
  })

  it('lets an explicit reactive entry beat the built-in pairing', () => {
    // Opting out has to be possible, which a truthiness check would prevent.
    expect(modeForSaver('Plasma', { Plasma: 'reactive' }).kind).toBe('reactive')
    expect(modeForSaver('Plasma', { Plasma: 'off' }).kind).toBe('off')
    expect(modeForSaver('Plasma', { Plasma: 'scene:warm_wit' }))
      .toEqual({ kind: 'scene', name: 'warm_wit' })
  })

  it('only pairs savers that have a genuinely matching effect', () => {
    // A mismatched effect is worse than the dominant colour: it puts the room
    // out of step with the screen. So this map stays small on purpose.
    for (const name of Object.values(DEFAULT_SAVER_MODES)) {
      expect(name.startsWith('effect:')).toBe(true)
      expect(EFFECT_DRIVERS[name.slice('effect:'.length)]).toBeDefined()
    }
  })
})

describe('undriven effects are started and left alone', () => {
  it('starts a non-field effect once and then stops talking to it', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ sceneBySaver: { a: 'effect:fire' } }))
    await sync.activate('a')
    relay.calls.length = 0

    for (let i = 0; i < 4; i++) {
      sync.offerFrame(frame())
      await h.flush()
      h.advance(SEND_INTERVAL_MS)
    }
    // One start, and no /field/params -- the relay cannot nudge it, and
    // re-POSTing would reset its animation phase every second.
    expect(relay.calls.map(c => c.url)).toEqual([`${BASE}/effects/fire`])
  })

  it('nudges a field effect on every send after the first', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ sceneBySaver: { a: 'effect:plasma' } }))
    await sync.activate('a')
    relay.calls.length = 0

    for (let i = 0; i < 3; i++) {
      sync.offerFrame(frame())
      await h.flush()
      h.advance(SEND_INTERVAL_MS)
    }
    expect(relay.calls.map(c => c.url)).toEqual([
      `${BASE}/effects/plasma`, `${BASE}/field/params`, `${BASE}/field/params`
    ])
  })

  it('sends plasma’s real parameters over the wire, not the spot’s', async () => {
    const relay = stubRelay()
    const { sync, h } = build(relay, config({ sceneBySaver: { a: 'effect:plasma' } }))
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(frame())
    await h.flush()
    expect(Object.keys(relay.calls[0].body).sort()).toEqual(['brightness', 'scale', 'speed'])
  })
})
