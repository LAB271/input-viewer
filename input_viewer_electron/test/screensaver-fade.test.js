// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The screensaver fades.
 *
 * The rotation used to be a single-frame cut: startScreensaver() stops the
 * running saver and starts the next one on the same canvas. Three fades replace
 * it -- overlay up on arrival, canvas dip on rotation, overlay down on exit.
 *
 * Each helper takes the swap as a callback, which is what makes this testable:
 * starting a real saver needs WebGL2 and jsdom has none, but the choreography --
 * what gets a class, when the callback fires, what is left behind -- is all
 * observable with a spy.
 *
 * The cases that matter are the interruptions. A dip that is cancelled halfway
 * must not leave the canvas at opacity 0, and a dismissal must not be restartable
 * by the detection loop that triggered it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, projectRoot } from './helpers/renderer-dom.js'

installRendererDom()

const fakeTrack = () => ({
  stop: vi.fn(),
  getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
  getCapabilities: () => ({
    width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 }
  })
})
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [fakeTrack()],
      getVideoTracks: () => [fakeTrack()],
      getAudioTracks: () => [],
    })),
    enumerateDevices: vi.fn(async () => []),
  },
  configurable: true,
})

const {
  elements, state, getDefaultSettings,
  revealScreensaver, swapScreensaver, dismissScreensaver, hideDvdScreensaver,
  SAVER_FADE_OUT_MS, SAVER_FADE_IN_MS,
} = await import('../src/renderer/renderer.js')

const CSS = readFileSync(
  path.resolve(projectRoot, 'src/renderer/styles.css'), 'utf8')

const overlay = () => elements.dvdOverlay
const canvas = () => elements.screensaverCanvas
const hidden = () => overlay().classList.contains('hidden')
const fading = () => overlay().classList.contains('fading')
const dipped = () => canvas().classList.contains('saver-swapping')

/** No reduced-motion preference, so the fades actually run. */
function motionAllowed(reduce = false) {
  globalThis.window.matchMedia = (q) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  motionAllowed(false)
  state.settings = { ...getDefaultSettings(), inputs: {} }
  overlay().classList.add('hidden')
  overlay().classList.remove('fading')
  canvas().classList.remove('saver-swapping')
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('arriving on screen', () => {
  it('fades the overlay up rather than snapping it on', () => {
    revealScreensaver(() => 'Plasma')
    expect(hidden()).toBe(false)
    // Ends without .fading, which is what animates it to full opacity.
    expect(fading()).toBe(false)
  })

  it('starts the saver only once the overlay is displayed', () => {
    // The saver reads the canvas for layout size, and display:none has none.
    // opacity:0 does, which is why the fade uses opacity rather than display.
    let displayedWhenStarted = null
    revealScreensaver(() => {
      displayedWhenStarted = !overlay().classList.contains('hidden')
      return 'Plasma'
    })
    expect(displayedWhenStarted).toBe(true)
  })

  it('returns the saver name through, for the log line', () => {
    expect(revealScreensaver(() => 'Truchet')).toBe('Truchet')
  })

  it('clears a dip left over from a previous rotation', () => {
    canvas().classList.add('saver-swapping')
    revealScreensaver(() => 'Plasma')
    // Otherwise the saver would start invisible and stay that way.
    expect(dipped()).toBe(false)
  })
})

describe('rotating between savers', () => {
  it('dips the canvas before swapping, not after', () => {
    const swap = vi.fn(() => 'Voronoi')
    swapScreensaver(swap)

    expect(dipped()).toBe(true)
    expect(swap).not.toHaveBeenCalled()

    // Nothing at one frame short of the dip.
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS - 1)
    expect(swap).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(swap).toHaveBeenCalledTimes(1)
  })

  it('lifts the dip once the new saver is running', () => {
    swapScreensaver(() => 'Voronoi')
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)
    // Removing the class is what animates back up, over the base rule's duration.
    expect(dipped()).toBe(false)
  })

  it('swaps at full black, never blending the two savers', () => {
    // Two unrelated abstract animations crossfaded read as mush. The dip must be
    // complete when the swap happens, which means the swap waits the full
    // fade-out and the class is still applied at that moment.
    let dippedAtSwap = null
    swapScreensaver(() => { dippedAtSwap = dipped(); return 'Voronoi' })
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)
    expect(dippedAtSwap).toBe(true)
  })

  it('a second rotation mid-dip cancels the first', () => {
    // Holding + repeats faster than the 300ms dip.
    const first = vi.fn()
    const second = vi.fn()
    swapScreensaver(first)
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS / 2)
    swapScreensaver(second)
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    // And it must not be left dipped.
    expect(dipped()).toBe(false)
  })

  it('never leaves the canvas dipped after a burst of steps', () => {
    for (let i = 0; i < 12; i++) {
      swapScreensaver(() => 'x')
      vi.advanceTimersByTime(40)
    }
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)
    expect(dipped()).toBe(false)
  })
})

describe('leaving the screen', () => {
  it('keeps the saver running through the fade, then stops it', () => {
    // A fade of live content, not of a frozen last frame.
    const stop = vi.fn()
    overlay().classList.remove('hidden')
    dismissScreensaver(stop)

    expect(fading()).toBe(true)
    expect(hidden()).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(hidden()).toBe(true)
  })

  it('leaves no classes behind for the next activation', () => {
    overlay().classList.remove('hidden')
    canvas().classList.add('saver-swapping')
    dismissScreensaver(() => {})
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)
    expect(fading()).toBe(false)
    expect(dipped()).toBe(false)
  })
})

describe('hideDvdScreensaver is safe to call repeatedly', () => {
  it('completes on schedule from the FIRST call, not the last', () => {
    // The assertion has to be about *when*, not just whether. An earlier version
    // of this test called hideDvdScreensaver() repeatedly and then advanced by a
    // full fade duration, which passes either way: without the guard the last
    // restart still completes, just later. Removing the guard did not fail it.
    //
    // What the guard actually buys is that repeated calls cannot push the stop
    // back indefinitely. So: keep calling during the fade, and assert it has
    // finished by the deadline set by the first call.
    overlay().classList.remove('hidden')
    hideDvdScreensaver()
    expect(fading()).toBe(true)

    // Every repeat lands strictly INSIDE the fade window; the final advance is
    // what crosses the deadline, with no call after it. (Calling once more after
    // the timer has fired would legitimately start a fresh fade, which is a
    // different thing from starving the first one.)
    const step = SAVER_FADE_OUT_MS / 4
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(step)
      hideDvdScreensaver()
    }
    vi.advanceTimersByTime(step)

    // Exactly SAVER_FADE_OUT_MS has elapsed since the first call.
    expect(hidden()).toBe(true)
    expect(fading()).toBe(false)
  })

  it('can activate again after a completed dismissal', () => {
    overlay().classList.remove('hidden')
    hideDvdScreensaver()
    vi.advanceTimersByTime(SAVER_FADE_OUT_MS)

    const name = revealScreensaver(() => 'Plasma')
    expect(name).toBe('Plasma')
    expect(hidden()).toBe(false)
    expect(fading()).toBe(false)
  })
})

describe('prefers-reduced-motion', () => {
  beforeEach(() => motionAllowed(true))

  it('arrives instantly, with nothing left mid-transition', () => {
    revealScreensaver(() => 'Plasma')
    expect(hidden()).toBe(false)
    expect(fading()).toBe(false)
    expect(dipped()).toBe(false)
  })

  it('rotates without a dip and without waiting', () => {
    const swap = vi.fn()
    swapScreensaver(swap)
    expect(swap).toHaveBeenCalledTimes(1)
    expect(dipped()).toBe(false)
  })

  it('leaves immediately', () => {
    const stop = vi.fn()
    overlay().classList.remove('hidden')
    dismissScreensaver(stop)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(hidden()).toBe(true)
    expect(fading()).toBe(false)
  })
})

describe('the CSS and the JS agree on duration', () => {
  // The classic drift: change one and the swap happens before or after the dip
  // has finished. #247 pins its own pair the same way.
  const ruleBody = (selector) => {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    const bodies = [...CSS.matchAll(re)].map(m => m[1])
    expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
    return bodies.join('\n')
  }

  it('matches the fade-out duration', () => {
    const ms = ruleBody('#screensaver-canvas.saver-swapping')
      .match(/transition:\s*opacity\s*(\d+)ms/)
    expect(ms, 'no opacity transition on .saver-swapping').not.toBeNull()
    expect(Number(ms[1])).toBe(SAVER_FADE_OUT_MS)
  })

  it('matches the fade-in duration', () => {
    const ms = ruleBody('#screensaver-canvas')
      .match(/transition:\s*opacity\s*(\d+)ms/)
    expect(Number(ms[1])).toBe(SAVER_FADE_IN_MS)
  })

  it('fades out quicker than it fades in', () => {
    // A slow dip to black reads as the wall dying; a slow rise reads as the next
    // thing arriving.
    expect(SAVER_FADE_OUT_MS).toBeLessThan(SAVER_FADE_IN_MS)
  })

  it('dips the canvas for rotation and the overlay for arrival', () => {
    // Fading the canvas on arrival would snap the split-flap board to black
    // first; fading the overlay on rotation would reveal the board mid-rotation.
    expect(ruleBody('#screensaver-canvas.saver-swapping')).toMatch(/opacity:\s*0/)
    expect(ruleBody('#dvd-overlay.fading')).toMatch(/opacity:\s*0/)
    expect(ruleBody('#dvd-overlay')).toMatch(/transition:\s*opacity/)
  })
})
