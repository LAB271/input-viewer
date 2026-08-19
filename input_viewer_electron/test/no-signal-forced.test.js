// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The no-signal state transition, driven through --no-signal (#248).
 *
 * Before this file, test/ covered compareFrames and the detection pacing but
 * nothing that drove showNoSignal/hideNoSignal -- the coverage stopped one layer
 * below the state change the whole feature exists to produce. #248 called that
 * out, and these are the tests it asked for.
 *
 * What is actually asserted here is the *pinning*: that --no-signal survives
 * every path that would otherwise clear the overlay. That single guard living in
 * hideNoSignal is the design, so these tests are what stop someone from
 * "simplifying" it back into the call sites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRendererDom, device } from './helpers/renderer-dom.js'

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
  state, elements, showNoSignal, hideNoSignal, applyForcedNoSignal,
  updateDvdScreensaver, startDetectionLoop, stopDetectionLoop,
  getDefaultSettings,
} = await import('../src/renderer/renderer.js')

const overlayFor = (side) => (side === 'left' ? elements.leftFeed : elements.rightFeed)
  .querySelector('.no-signal-overlay')

const isVisible = (side) => !overlayFor(side).classList.contains('hidden')

function reset({ noSignal = false, delayMs = 5 * 60 * 1000 } = {}) {
  stopDetectionLoop()
  state.settings = { ...getDefaultSettings(), inputs: {} }
  state.devices = [device('cam1'), device('cam2')]
  state.layoutMode = 'dual'
  state.leftDeviceId = 'cam1'
  state.rightDeviceId = 'cam2'
  state.noSignalState.left = false
  state.noSignalState.right = false
  state.dvdScreensaverDelay = delayMs
  if (state.dvdScreensaverTimeout) {
    clearTimeout(state.dvdScreensaverTimeout)
    state.dvdScreensaverTimeout = null
  }
  state.testFlags = {
    mock: false, mockInputs: 0, noSignal, screensaverDelayMs: null,
  }
  // Both overlays start hidden, as they do in index.html.
  overlayFor('left').classList.add('hidden')
  overlayFor('right').classList.add('hidden')
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

afterEach(() => {
  stopDetectionLoop()
  if (state.dvdScreensaverTimeout) {
    clearTimeout(state.dvdScreensaverTimeout)
    state.dvdScreensaverTimeout = null
  }
})

describe('the ordinary transition, with no flags set', () => {
  it('shows and hides the overlay per side', () => {
    expect(isVisible('left')).toBe(false)

    showNoSignal('left')
    expect(isVisible('left')).toBe(true)
    expect(state.noSignalState.left).toBe(true)
    // The other side is untouched: each feed detects independently.
    expect(isVisible('right')).toBe(false)
    expect(state.noSignalState.right).toBe(false)

    hideNoSignal('left')
    expect(isVisible('left')).toBe(false)
    expect(state.noSignalState.left).toBe(false)
  })

  it('is idempotent in both directions', () => {
    // The detection loop only calls these on an edge, but a re-entrant cycle
    // or a synced same-device pair can call twice.
    showNoSignal('left')
    showNoSignal('left')
    expect(isVisible('left')).toBe(true)
    hideNoSignal('left')
    hideNoSignal('left')
    expect(isVisible('left')).toBe(false)
  })

  it('does nothing on start-up until something calls it', () => {
    applyForcedNoSignal()
    expect(isVisible('left')).toBe(false)
    expect(isVisible('right')).toBe(false)
  })
})

describe('--no-signal pins the state', () => {
  it('forces both sides on', () => {
    reset({ noSignal: true })
    applyForcedNoSignal()

    expect(isVisible('left')).toBe(true)
    expect(isVisible('right')).toBe(true)
    expect(state.noSignalState.left).toBe(true)
    expect(state.noSignalState.right).toBe(true)
  })

  it('refuses to clear the overlay', () => {
    reset({ noSignal: true })
    applyForcedNoSignal()

    // This is the call detection makes when it decides signal is back, and the
    // call a stream makes when it starts successfully. Both must be no-ops.
    hideNoSignal('left')
    hideNoSignal('right')

    expect(isVisible('left')).toBe(true)
    expect(isVisible('right')).toBe(true)
    expect(state.noSignalState.left).toBe(true)
    expect(state.noSignalState.right).toBe(true)
  })

  it('keeps the state pinned across repeated clear attempts', () => {
    reset({ noSignal: true })
    applyForcedNoSignal()
    for (let i = 0; i < 20; i++) {
      hideNoSignal('left')
      hideNoSignal('right')
    }
    expect(state.noSignalState.left).toBe(true)
    expect(state.noSignalState.right).toBe(true)
  })

  it('stops the detection loop from starting at all', () => {
    reset({ noSignal: true })
    startDetectionLoop()
    // Not merely ignored -- not running. Detection's verdict is overridden, so
    // the per-cycle GPU readback would be spent on a discarded result.
    expect(state.detectionRunning).toBe(false)
  })

  it('still lets detection run when the flag is absent', () => {
    reset({ noSignal: false })
    startDetectionLoop()
    expect(state.detectionRunning).toBe(true)
    stopDetectionLoop()
  })
})

describe('reaching the screensaver without hardware', () => {
  it('arms the screensaver timer when forced no-signal covers both sides', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    reset({ noSignal: true, delayMs: 1500 })

    applyForcedNoSignal()

    // applyForcedNoSignal calls updateDvdScreensaver, which is what turns
    // "--no-signal --screensaver-delay=0" into a screensaver on screen.
    expect(state.dvdScreensaverTimeout).not.toBeNull()
    const delays = setTimeoutSpy.mock.calls.map(c => c[1])
    expect(delays).toContain(1500)
    setTimeoutSpy.mockRestore()
  })

  it('honours a zero delay as a real value, not an absent one', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    reset({ noSignal: true, delayMs: 0 })

    applyForcedNoSignal()

    expect(state.dvdScreensaverTimeout).not.toBeNull()
    expect(setTimeoutSpy.mock.calls.map(c => c[1])).toContain(0)
    setTimeoutSpy.mockRestore()
  })

  it('does not arm the timer while only one side of a dual wall is dark', () => {
    reset()
    showNoSignal('left')
    updateDvdScreensaver()
    expect(state.dvdScreensaverTimeout).toBeNull()

    showNoSignal('right')
    updateDvdScreensaver()
    expect(state.dvdScreensaverTimeout).not.toBeNull()
  })

  it('cancels the armed timer when signal returns', () => {
    reset()
    showNoSignal('left')
    showNoSignal('right')
    updateDvdScreensaver()
    expect(state.dvdScreensaverTimeout).not.toBeNull()

    hideNoSignal('left')
    updateDvdScreensaver()
    expect(state.dvdScreensaverTimeout).toBeNull()
  })

  it('arms on the left side alone in single view', () => {
    reset()
    state.layoutMode = 'single'
    showNoSignal('left')
    updateDvdScreensaver()
    expect(state.dvdScreensaverTimeout).not.toBeNull()
  })
})
