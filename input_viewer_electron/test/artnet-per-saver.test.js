// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Per-screensaver lighting, and putting the room back afterwards.
 *
 * The behaviour being protected: while a screensaver is up the room follows it,
 * and when a laptop is plugged in the room returns to *how it was* -- not to a
 * configured guess, and not to whatever the last screensaver frame happened to
 * be. That requires reading the relay's state before taking it over, which is
 * the only read this app makes.
 *
 * Two failure modes are worth more than the rest:
 *
 * **Re-snapshotting on rotation.** Rotation happens every few minutes while the
 * wall is dark. If it took a fresh snapshot, the "before" state would become the
 * previous screensaver's own lighting, and the room would never return to how it
 * started. The original snapshot has to survive every rotation.
 *
 * **Restoring from a failed read.** If GET /status fails there is no snapshot,
 * and restoring from an empty one would leave the room lit with no way back.
 * Absent a snapshot the code must fall through to the old release behaviour.
 *
 * The rig is untouched: everything goes through the injected transport.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createArtnetSync,
  modeForSaver,
  summariseState,
  statusEndpoint,
  sceneEndpoint,
  stripEndpoint,
  SEND_INTERVAL_MS
} from '../src/renderer/screensavers/artnet-sync.js'

const BASE = 'http://pi.labs:8000'

function harness() {
  let clock = 1_700_000_000_000
  return {
    now: () => clock,
    advance(ms) { clock += ms },
    setTimer: () => 1,
    clearTimer: () => {},
    async flush(n = 30) { for (let i = 0; i < n; i++) await Promise.resolve() }
  }
}

/** A stub relay that answers GET /status from a supplied body. */
function stubRelay({ status = null, readFails = false } = {}) {
  const calls = []
  const impl = vi.fn(async (url, init) => {
    const method = init?.method || 'POST'
    if (method === 'GET') {
      calls.push({ url, method: 'GET' })
      if (readFails) throw new TypeError('Failed to fetch')
      return { ok: true, status: 200, json: async () => status }
    }
    calls.push({ url, method: 'POST', body: JSON.parse(init?.body || '{}') })
    return { ok: true, status: 200 }
  })
  return { impl, calls, posts: () => calls.filter(c => c.method === 'POST') }
}

const config = (over = {}) => () => ({
  enabled: true, url: BASE, target: 'all',
  releaseScene: '', maxBrightness: 1, sceneBySaver: {}, ...over
})

function build(relay, cfg = config(), h = harness()) {
  return {
    sync: createArtnetSync({
      getConfig: cfg, fetchImpl: relay.impl,
      now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer
    }),
    h
  }
}

/** /status for a room sitting on one uniform colour. */
const uniformStatus = (rgb = [40, 10, 80], brightness = 0.6, effect = null) => ({
  effect,
  strips: Array.from({ length: 40 }, (_, i) => ({
    name: `u0_${String(i + 1).padStart(2, '0')}`, rgb, brightness
  }))
})

/** /status where strips differ, so a single /all cannot restore it. */
function mixedStatus() {
  const s = uniformStatus()
  s.strips[7] = { name: 'u0_08', rgb: [255, 0, 0], brightness: 1 }
  return s
}

const frame = (r = 200, g = 90, b = 30) => {
  const buf = new Uint8Array(8 * 8 * 8 * 4 * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255
  }
  return buf
}

describe('modeForSaver', () => {
  it('defaults to reactive, so an empty map changes nothing', () => {
    expect(modeForSaver('plasma', {})).toEqual({ kind: 'reactive', name: '' })
    expect(modeForSaver('plasma', undefined)).toEqual({ kind: 'reactive', name: '' })
    expect(modeForSaver('plasma', { plasma: 'reactive' })).toEqual({ kind: 'reactive', name: '' })
  })

  it('reads scene, effect and off', () => {
    expect(modeForSaver('a', { a: 'scene:warm_wit' })).toEqual({ kind: 'scene', name: 'warm_wit' })
    expect(modeForSaver('a', { a: 'effect:spot' })).toEqual({ kind: 'effect', name: 'spot' })
    expect(modeForSaver('a', { a: 'off' })).toEqual({ kind: 'off', name: '' })
  })

  it('falls back to reactive on a malformed entry, not to silence', () => {
    // A typo in a hand-edited map should look like the old behaviour. Silence
    // would read as the lighting having broken.
    for (const bad of ['scene:', 'effect:', 'nonsense', '', 'scene', null]) {
      expect(modeForSaver('a', { a: bad }).kind).toBe('reactive')
    }
  })

  it('only applies the entry for the saver asked about', () => {
    const map = { plasma: 'off' }
    expect(modeForSaver('plasma', map).kind).toBe('off')
    expect(modeForSaver('frost', map).kind).toBe('reactive')
  })
})

describe('summariseState', () => {
  it('detects a uniform room so one /all can restore it', () => {
    const sum = summariseState(uniformStatus([40, 10, 80], 0.6))
    expect(sum.uniform).toEqual({ r: 40, g: 10, b: 80, brightness: 0.6 })
    expect(sum.strips).toHaveLength(40)
  })

  it('refuses to call a mixed room uniform', () => {
    expect(summariseState(mixedStatus()).uniform).toBeNull()
  })

  it('treats a brightness-only difference as mixed', () => {
    // Same colour everywhere but one strip dimmed. Comparing only rgb would call
    // this uniform and flatten that strip to full brightness on restore.
    const st = uniformStatus([40, 10, 80], 0.6)
    st.strips[3] = { name: 'u0_04', rgb: [40, 10, 80], brightness: 0.2 }
    const sum = summariseState(st)
    expect(sum.uniform).toBeNull()
    expect(sum.strips[3].brightness).toBe(0.2)
  })

  it('keeps a running effect by name, from either shape', () => {
    expect(summariseState(uniformStatus([0, 0, 0], 1, 'aurora')).effect).toBe('aurora')
    expect(summariseState(uniformStatus([0, 0, 0], 1, { name: 'ripple' })).effect).toBe('ripple')
    expect(summariseState(uniformStatus()).effect).toBeNull()
  })

  it('returns null for a body it cannot use', () => {
    expect(summariseState(null)).toBeNull()
    expect(summariseState({})).toBeNull()
    expect(summariseState({ strips: [] })).toBeNull()
    expect(summariseState({ strips: 'nope' })).toBeNull()
  })

  it('treats lights-off as a real state worth restoring', () => {
    // The wall's room sits at (0,0,0). If this came back null, plugging a laptop
    // in would leave the lights on.
    const sum = summariseState(uniformStatus([0, 0, 0], 1))
    expect(sum).not.toBeNull()
    expect(sum.uniform).toEqual({ r: 0, g: 0, b: 0, brightness: 1 })
  })
})

describe('activation', () => {
  it('reads the room before touching it', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay)
    await sync.activate('plasma')
    expect(relay.calls[0]).toMatchObject({ url: statusEndpoint(BASE), method: 'GET' })
    expect(sync.getStatus().hasPriorState).toBe(true)
  })

  it('posts the scene for a saver mapped to one', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay, config({ sceneBySaver: { matrixRain: 'scene:lab_modus' } }))
    await sync.activate('matrixRain')
    expect(relay.posts().map(c => c.url)).toEqual([sceneEndpoint(BASE, 'lab_modus')])
  })

  it('sends nothing on activation for a reactive saver', async () => {
    // Reactive is driven from the frames. Posting a colour here would only be
    // overwritten a moment later.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay)
    await sync.activate('plasma')
    expect(relay.posts()).toHaveLength(0)
  })

  it('does not re-snapshot if activate is called twice without a release', async () => {
    // Belt and braces alongside rotate(): any second take-over before a release
    // would overwrite the only record of the room's original state.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay)
    await sync.activate('a')
    await sync.activate('a')
    await sync.activate('b')
    expect(relay.calls.filter(c => c.method === 'GET')).toHaveLength(1)
  })

  it('does not read or write when disabled', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay, config({ enabled: false }))
    await sync.activate('plasma')
    expect(relay.calls).toHaveLength(0)
  })
})

describe('per-saver modes while frames arrive', () => {
  it('holds a scene instead of letting the reactive colour overwrite it', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({ sceneBySaver: { a: 'scene:warm_wit' } }))
    await sync.activate('a')
    relay.calls.length = 0

    for (let i = 0; i < 5; i++) {
      sync.offerFrame(frame())
      await h.flush()
      h.advance(SEND_INTERVAL_MS)
    }
    expect(relay.posts()).toHaveLength(0)
  })

  it('sends nothing at all for a saver mapped to off', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({ sceneBySaver: { a: 'off' } }))
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts()).toHaveLength(0)
  })

  it('lets a per-saver effect override the global colour target', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({
      target: 'all', sceneBySaver: { a: 'effect:aurora' }
    }))
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts()[0].url).toBe(`${BASE}/effects/aurora`)
  })

  it('still drives the reactive colour for an unmapped saver', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({ sceneBySaver: { other: 'off' } }))
    await sync.activate('a')
    relay.calls.length = 0

    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts()[0].url).toBe(`${BASE}/all`)
  })
})

describe('rotation', () => {
  it('does NOT re-snapshot, so the original state survives', async () => {
    const relay = stubRelay({ status: uniformStatus([40, 10, 80], 0.6) })
    const { sync } = build(relay, config({ sceneBySaver: { b: 'scene:warm_wit' } }))
    await sync.activate('a')
    const reads = () => relay.calls.filter(c => c.method === 'GET').length
    expect(reads()).toBe(1)

    await sync.rotate('b')
    await sync.rotate('a')
    await sync.rotate('b')
    // Still one read. A second would have captured our own lighting as the
    // "before" state and the room could never be returned.
    expect(reads()).toBe(1)
  })

  it('restores the ORIGINAL colour after rotating through other savers', async () => {
    const relay = stubRelay({ status: uniformStatus([40, 10, 80], 0.6) })
    const { sync } = build(relay, config({ sceneBySaver: { b: 'scene:warm_wit' } }))
    await sync.activate('a')
    await sync.rotate('b')
    relay.calls.length = 0

    await sync.release()
    const restore = relay.posts().find(c => c.url === `${BASE}/all`)
    expect(restore.body).toMatchObject({ r: 40, g: 10, b: 80, brightness: 0.6 })
  })

  it('does not post a spurious /stop when no effect was running', async () => {
    // Rotating between two savers that never started an effect must not tell the
    // relay to stop one -- that would cancel whatever else owns the room.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay, config({
      sceneBySaver: { b: 'scene:warm_wit', c: 'scene:diep_blauw' }
    }))
    await sync.activate('b')
    relay.calls.length = 0

    await sync.rotate('c')
    await sync.rotate('b')
    expect(relay.posts().map(c => c.url)).toEqual([
      sceneEndpoint(BASE, 'diep_blauw'), sceneEndpoint(BASE, 'warm_wit')
    ])
  })

  it('keeps a globally-targeted effect running across reactive savers', async () => {
    // Both savers are reactive and the global target is the spot, so the effect
    // should simply keep running and be re-coloured. Stopping and restarting it
    // on every rotation would show as a flicker every few minutes.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({ target: 'effect:spot' }))
    await sync.activate('a')
    sync.offerFrame(frame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    relay.calls.length = 0

    await sync.rotate('b')
    await sync.rotate('c')
    expect(relay.posts().map(c => c.url)).not.toContain(`${BASE}/stop`)
    expect(sync.getStatus().runningEffect).toBe('spot')

    // And the next frame nudges rather than restarting.
    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts()[0].url).toBe(`${BASE}/field/params`)
  })

  it('stops a globally-targeted effect when rotating to a scene saver', async () => {
    // The saver's own mode is 'reactive' here -- the effect comes from the global
    // artnetTarget. Keying the stop off the previous MODE would skip it and leave
    // the room animating underneath the scene.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({
      target: 'effect:spot', sceneBySaver: { b: 'scene:warm_wit' }
    }))
    await sync.activate('a')
    sync.offerFrame(frame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    expect(sync.getStatus().runningEffect).toBe('spot')
    relay.calls.length = 0

    await sync.rotate('b')
    expect(relay.posts().map(c => c.url)).toEqual([
      `${BASE}/stop`, sceneEndpoint(BASE, 'warm_wit')
    ])
  })

  it('starts the new effect by name when the effect changes', async () => {
    // A boolean "is an effect running" would report true here and send a
    // /field/params nudge that aurora, never started, would not receive.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({
      target: 'effect:spot', sceneBySaver: { b: 'effect:aurora' }
    }))
    await sync.activate('a')
    sync.offerFrame(frame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    await sync.rotate('b')
    relay.calls.length = 0

    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts()[0].url).toBe(`${BASE}/effects/aurora`)
  })

  it('switches effect to effect directly, without stopping in between', async () => {
    // A /stop here would darken the room for a beat before the next effect took
    // hold. Starting the new effect replaces the old one on the relay, so the
    // stop is both unnecessary and visible.
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({
      sceneBySaver: { a: 'effect:spot', b: 'effect:aurora' }
    }))
    await sync.activate('a')
    sync.offerFrame(frame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    relay.calls.length = 0

    await sync.rotate('b')
    expect(relay.posts().map(c => c.url)).not.toContain(`${BASE}/stop`)

    sync.offerFrame(frame())
    await h.flush()
    expect(relay.posts().map(c => c.url)).toContain(`${BASE}/effects/aurora`)
  })

  it('stops an effect when rotating to a saver that does not want one', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync, h } = build(relay, config({
      sceneBySaver: { a: 'effect:spot', b: 'scene:warm_wit' }
    }))
    await sync.activate('a')
    sync.offerFrame(frame())
    await h.flush()
    h.advance(SEND_INTERVAL_MS)
    relay.calls.length = 0

    await sync.rotate('b')
    // Without the stop the room would keep animating underneath the scene.
    expect(relay.posts().map(c => c.url)).toEqual([
      `${BASE}/stop`, sceneEndpoint(BASE, 'warm_wit')
    ])
  })
})

describe('release restores the room', () => {
  it('puts a uniform room back with one /all', async () => {
    const relay = stubRelay({ status: uniformStatus([40, 10, 80], 0.6) })
    const { sync } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    const posts = relay.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`${BASE}/all`)
    expect(posts[0].body).toMatchObject({ r: 40, g: 10, b: 80, brightness: 0.6 })
  })

  it('restores lights-off rather than leaving the room lit', async () => {
    const relay = stubRelay({ status: uniformStatus([0, 0, 0], 1) })
    const { sync } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    expect(relay.posts()[0].body).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('restores a mixed room strip by strip', async () => {
    const relay = stubRelay({ status: mixedStatus() })
    const { sync } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    const posts = relay.posts()
    expect(posts).toHaveLength(40)
    expect(posts[0].url).toBe(stripEndpoint(BASE, 'u0_01'))
    const odd = posts.find(c => c.url === stripEndpoint(BASE, 'u0_08'))
    expect(odd.body).toMatchObject({ r: 255, g: 0, b: 0 })
  })

  it('restarts an effect that was already running before we arrived', async () => {
    const relay = stubRelay({ status: uniformStatus([0, 0, 0], 1, 'aurora') })
    const { sync } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    // The room was moving when we found it, so it should be moving when we
    // leave -- not frozen on whichever frame /status happened to sample.
    expect(relay.posts().map(c => c.url)).toEqual([`${BASE}/effects/aurora`])
  })

  it('falls back to the release scene when the read failed', async () => {
    const relay = stubRelay({ readFails: true })
    const { sync } = build(relay, config({ releaseScene: 'warm_wit' }))
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    expect(relay.posts().map(c => c.url)).toEqual([sceneEndpoint(BASE, 'warm_wit')])
  })

  it('sends nothing when the read failed and no release scene is set', async () => {
    // The fixtures keep their last colour. Never a blackout: a room that may
    // have people in it does not go dark because a video signal came back.
    const relay = stubRelay({ readFails: true })
    const { sync } = build(relay)
    await sync.activate('a')
    relay.calls.length = 0

    await sync.release()
    expect(relay.posts()).toHaveLength(0)
  })

  it('clears the snapshot, so a second release does not re-post it', async () => {
    const relay = stubRelay({ status: uniformStatus() })
    const { sync } = build(relay)
    await sync.activate('a')
    await sync.release()
    relay.calls.length = 0

    await sync.release()
    expect(relay.posts()).toHaveLength(0)
    expect(sync.getStatus().hasPriorState).toBe(false)
  })

  it('takes a fresh snapshot on the next activation', async () => {
    const relay = stubRelay({ status: uniformStatus([1, 2, 3], 1) })
    const { sync } = build(relay)
    await sync.activate('a')
    await sync.release()
    await sync.activate('a')
    expect(relay.calls.filter(c => c.method === 'GET')).toHaveLength(2)
  })
})
