// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Dropdown input thumbnails (#242).
 *
 * The decision was snapshots rather than live previews, taken when the dropdown
 * opens, iterating the inputs. That choice is what let #261 close, and the
 * invariant it rests on is **never more than one temporary stream open at a
 * time** -- so that is what most of this file is about.
 *
 * The store takes its capture and DOM dependencies as arguments, which is what
 * makes any of this testable: jsdom has no capture pipeline, no getUserMedia and
 * no real canvas, but the sequencing is all observable through spies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, projectRoot } from './helpers/renderer-dom.js'

installRendererDom()

const {
  createThumbnailStore, snapshotFromVideo, waitForFrame,
  THUMB_WIDTH, THUMB_HEIGHT, FRAME_TIMEOUT_MS,
} = await import('../src/renderer/input-thumbnails.js')

const CSS = readFileSync(
  path.resolve(projectRoot, 'src/renderer/styles.css'), 'utf8')

/** A video element with a decoded frame, as far as the code can tell. */
const readyVideo = (w = 1920, h = 1080) => ({
  videoWidth: w, videoHeight: h, readyState: 2,
  play: vi.fn(async () => {}),
  srcObject: {},
})

/** A stream handle like openTemporaryStream returns. */
function fakeHandle(tracker) {
  const handle = {
    stream: {},
    stop: vi.fn(() => { tracker.open-- }),
  }
  tracker.open++
  tracker.peak = Math.max(tracker.peak, tracker.open)
  return handle
}

function makeStore({
  inputs = ['a', 'b', 'c'],
  live = {},
  failOn = [],
  tracker = { open: 0, peak: 0 },
} = {}) {
  const painted = []
  const store = createThumbnailStore({
    listInputs: () => inputs.map(id => ({ deviceId: id, label: `Cam ${id}` })),
    liveVideoFor: (id) => live[id] ?? null,
    openTemporaryStream: async (id) => {
      if (failOn.includes(id)) throw new Error('device busy')
      return fakeHandle(tracker)
    },
    onThumbnail: (id, url) => painted.push({ id, url }),
  })
  return { store, painted, tracker }
}

// The DOM fixture's canvas stub, captured before any test replaces it. Two tests
// below swap in their own getContext to observe or break drawImage; without
// restoring it here they poison every later test in the file. That is exactly how
// the cache test first failed -- against a context that threw, not against the
// code under test.
const BASE_GET_CONTEXT = globalThis.HTMLCanvasElement.prototype.getContext

beforeEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = BASE_GET_CONTEXT

  // A real frame arrives immediately for every temporary stream in these tests;
  // the timeout path is covered separately against waitForFrame directly.
  globalThis.HTMLVideoElement.prototype.requestVideoFrameCallback =
    function (cb) { Object.defineProperty(this, 'videoWidth', { value: 1280, configurable: true }); Object.defineProperty(this, 'videoHeight', { value: 720, configurable: true }); Object.defineProperty(this, 'readyState', { value: 2, configurable: true }); cb() }
  globalThis.HTMLVideoElement.prototype.play = vi.fn(async () => {})
})

describe('snapshotFromVideo', () => {
  it('returns null when there is no decoded frame to draw', () => {
    // drawImage on a 0x0 source silently produces a blank rather than failing,
    // so this has to be checked rather than attempted.
    expect(snapshotFromVideo({ videoWidth: 0, videoHeight: 0 })).toBeNull()
    expect(snapshotFromVideo(null)).toBeNull()
  })

  it('produces a data URL from a ready element', () => {
    const url = snapshotFromVideo(readyVideo())
    expect(url).toMatch(/^data:image\//)
  })

  it('crops rather than squashes a source of a different aspect', () => {
    // A squashed preview is harder to recognise than a cropped one. Assert the
    // source rect handed to drawImage, since jsdom cannot show us pixels.
    const calls = []
    globalThis.HTMLCanvasElement.prototype.getContext = () => ({
      drawImage: (...args) => calls.push(args),
    })

    // 4:3 into 16:9 -> crop top and bottom.
    snapshotFromVideo(readyVideo(1600, 1200))
    let [, sx, sy, sw, sh] = calls.at(-1)
    expect(sx).toBe(0)
    expect(sw).toBe(1600)
    expect(sh).toBeCloseTo(1600 / (THUMB_WIDTH / THUMB_HEIGHT), 3)
    expect(sy).toBeGreaterThan(0)

    // 21:9 into 16:9 -> crop left and right.
    snapshotFromVideo(readyVideo(2560, 1080))
    ;[, sx, sy, sw, sh] = calls.at(-1)
    expect(sy).toBe(0)
    expect(sh).toBe(1080)
    expect(sw).toBeCloseTo(1080 * (THUMB_WIDTH / THUMB_HEIGHT), 3)
    expect(sx).toBeGreaterThan(0)
  })
})

describe('waitForFrame', () => {
  it('resolves immediately for an element that already has a frame', async () => {
    await expect(waitForFrame(readyVideo())).resolves.toBe(true)
  })

  it('gives up rather than hanging the sweep', async () => {
    vi.useFakeTimers()
    // A device that negotiates but never presents. One dead input must not hold
    // up the rest of the row.
    const dead = { videoWidth: 0, videoHeight: 0, readyState: 0 }
    const p = waitForFrame(dead, 500)
    vi.advanceTimersByTime(500)
    await expect(p).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('has a bounded default', () => {
    expect(FRAME_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FRAME_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })
})

describe('the sweep opens one stream at a time', () => {
  it('never has two temporary streams open at once', async () => {
    // The invariant the whole design rests on, and the reason #261 could close.
    const { store, tracker } = makeStore({ inputs: ['a', 'b', 'c', 'd'] })
    await store.sweep()
    expect(tracker.peak).toBe(1)
    expect(tracker.open).toBe(0) // every one released
  })

  it('releases each stream before moving on', async () => {
    const order = []
    const store = createThumbnailStore({
      listInputs: () => [{ deviceId: 'a' }, { deviceId: 'b' }],
      liveVideoFor: () => null,
      openTemporaryStream: async (id) => {
        order.push(`open:${id}`)
        return { stream: {}, stop: () => order.push(`stop:${id}`) }
      },
      onThumbnail: () => {},
    })
    await store.sweep()
    expect(order).toEqual(['open:a', 'stop:a', 'open:b', 'stop:b'])
  })

  it('opens no stream at all for an input already on screen', async () => {
    // Left and right are streaming already; their stills come straight off the
    // live element. This is most of why the sweep is cheap.
    const { store, tracker, painted } = makeStore({
      inputs: ['a', 'b'],
      live: { a: readyVideo() },
    })
    await store.sweep()
    expect(tracker.peak).toBe(1) // only 'b' needed one
    expect(painted.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('falls back to a stream when the live element has no frame yet', async () => {
    // The element exists but the device is still starting up.
    const { store, tracker } = makeStore({
      inputs: ['a'],
      live: { a: { videoWidth: 0, videoHeight: 0, readyState: 0 } },
    })
    await store.sweep()
    expect(tracker.peak).toBe(1)
  })
})

describe('a capture that fails is a placeholder, not an error', () => {
  it('carries on through a device that refuses to open', async () => {
    // Exclusive-access capture cards are normal. One failure must not abort the
    // rest of the sweep.
    const { store, painted } = makeStore({
      inputs: ['a', 'b', 'c'],
      failOn: ['b'],
    })
    await store.sweep()
    expect(painted.map(p => p.id)).toEqual(['a', 'c'])
    expect(store.get('b')).toBeNull()
  })

  it('caches nothing for a failed input, so the tile stays a placeholder', async () => {
    const { store } = makeStore({ inputs: ['a'], failOn: ['a'] })
    await store.sweep()
    expect(store.entries()).toEqual([])
  })

  it('releases the stream even when drawing throws', async () => {
    const tracker = { open: 0, peak: 0 }
    globalThis.HTMLCanvasElement.prototype.getContext = () => ({
      drawImage: () => { throw new Error('tainted') },
    })
    const { store } = makeStore({ inputs: ['a'], tracker })
    await store.sweep()
    expect(tracker.open).toBe(0)
  })
})

describe('repeated opening does not stack sweeps', () => {
  it('ignores a second sweep while one is running', async () => {
    // The dropdown can be opened, closed and reopened faster than one cold
    // capture takes. Stacking would hold a stream open per repeat.
    let opens = 0
    let release = null
    const store = createThumbnailStore({
      listInputs: () => [{ deviceId: 'a' }],
      liveVideoFor: () => null,
      openTemporaryStream: () => {
        opens++
        return new Promise(res => { release = () => res({ stream: {}, stop: () => {} }) })
      },
      onThumbnail: () => {},
    })

    const first = store.sweep()
    expect(store.sweeping).toBe(true)
    await store.sweep() // ignored
    await store.sweep() // ignored
    expect(opens).toBe(1)

    release()
    await first
    expect(store.sweeping).toBe(false)
  })

  it('allows a fresh sweep once the previous one finished', async () => {
    const { store, tracker } = makeStore({ inputs: ['a'] })
    await store.sweep()
    await store.sweep()
    expect(tracker.peak).toBe(1)
  })

  it('reset supersedes a running sweep', async () => {
    const painted = []
    let release = null
    const store = createThumbnailStore({
      listInputs: () => [{ deviceId: 'a' }, { deviceId: 'b' }],
      liveVideoFor: () => null,
      openTemporaryStream: () => new Promise(res => {
        release = () => res({ stream: {}, stop: () => {} })
      }),
      onThumbnail: (id) => painted.push(id),
    })
    const p = store.sweep()
    store.reset()
    release()
    await p
    // The in-flight result belongs to a superseded generation and is dropped.
    expect(painted).toEqual([])
    expect(store.entries()).toEqual([])
  })
})

describe('the cache survives a row re-render', () => {
  it('keeps stills keyed by device so rebuilt rows can be repainted', async () => {
    // renderDropdownInputLists() rebuilds the row DOM on any device or selection
    // change, which can happen mid-sweep. A held node reference would go stale;
    // a cached data URL does not.
    const { store } = makeStore({ inputs: ['a', 'b'] })
    await store.sweep()
    expect(store.get('a')).toMatch(/^data:image\//)
    expect(store.entries()).toHaveLength(2)
  })
})

describe('the tile is sized, not stretched', () => {
  const ruleBody = (selector) => {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    const bodies = [...CSS.matchAll(re)].map(m => m[1])
    expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
    return bodies.join('\n')
  }

  it('uses a fixed tile size rather than the full row width', () => {
    // The first attempt used width:100% + aspect-ratio. Measured at 1280x800
    // that gave 292x164 tiles and 218px rows in the single list -- 1166px of
    // content in a 640px panel, so a four-input picker scrolled.
    const body = ruleBody('.input-thumb')
    expect(body).toMatch(/width:\s*var\(--input-thumb-w\)/)
    expect(body).toMatch(/height:\s*var\(--input-thumb-h\)/)
    expect(body).not.toMatch(/width:\s*100%/)
  })

  it('lays each list out for its own width', () => {
    // ~149px dual columns have no room for a name beside the tile; ~322px single
    // rows do. One rule for both would be wrong in one of them.
    expect(ruleBody('.input-option')).toMatch(/flex-direction:\s*column/)
    expect(ruleBody('.single-input-option')).toMatch(/flex-direction:\s*row/)
  })

  it('never lets the tile absorb the row slack', () => {
    // The name is what should flex, or a long label squeezes the preview.
    expect(ruleBody('.input-thumb')).toMatch(/flex-shrink:\s*0/)
  })

  it('declares the stored image at the same aspect as the tile', () => {
    // Stored 16:9 and displayed 16:9, so background-size:cover is a no-op crop
    // rather than a second, different one.
    const w = CSS.match(/--input-thumb-w:\s*(\d+)px/)
    const h = CSS.match(/--input-thumb-h:\s*(\d+)px/)
    expect(w, 'no --input-thumb-w').not.toBeNull()
    expect(Number(w[1]) / Number(h[1]))
      .toBeCloseTo(THUMB_WIDTH / THUMB_HEIGHT, 2)
  })
})
