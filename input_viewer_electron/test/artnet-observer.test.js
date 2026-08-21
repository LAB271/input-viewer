// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The Art-Net frame observer is registered only while Art-Net is enabled.
 *
 * This is the wiring behind a 40x regression on the videowall. The observer was
 * registered unconditionally at startup on the reasoning that it is "a no-op while
 * disabled" -- true of the observer, false of the READBACK, which gl-base performs
 * before calling anyone. With Art-Net off, the wall still paid 32 synchronous
 * gl.readPixels per frame per runtime and measured 1.4 fps.
 *
 * So the invariant worth pinning is narrow and specific: with the setting off,
 * nothing is registered at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const { frameObserverCount } =
  await import('../src/renderer/screensavers/gl-base.js')
const { state, getDefaultSettings, syncArtnetFrameObserver } =
  await import('../src/renderer/renderer.js')

function setArtnet(enabled) {
  state.settings = { ...getDefaultSettings(), inputs: {}, artnetEnabled: enabled }
  syncArtnetFrameObserver()
}

beforeEach(() => {
  // Leave nothing registered between tests: the observer list is module state.
  setArtnet(false)
})

describe('registration follows the setting', () => {
  it('registers nothing while Art-Net is disabled', () => {
    // The whole bug. Off is the wall's configuration, and off must cost nothing.
    setArtnet(false)
    expect(frameObserverCount()).toBe(0)
  })

  it('registers exactly one observer when enabled', () => {
    setArtnet(true)
    expect(frameObserverCount()).toBe(1)
  })

  it('removes it again when disabled', () => {
    setArtnet(true)
    setArtnet(false)
    expect(frameObserverCount()).toBe(0)
  })

  it('does not stack observers when called repeatedly while enabled', () => {
    // saveSettings() calls this on every settings change, and settings are saved
    // often. Stacking would multiply the readback rather than remove it.
    setArtnet(true)
    for (let i = 0; i < 10; i++) syncArtnetFrameObserver()
    expect(frameObserverCount()).toBe(1)
  })

  it('survives being toggled repeatedly', () => {
    // Toggling without a restart is the property the original unconditional
    // registration was protecting; it still has to hold.
    for (let i = 0; i < 5; i++) {
      setArtnet(true)
      expect(frameObserverCount()).toBe(1)
      setArtnet(false)
      expect(frameObserverCount()).toBe(0)
    }
  })

  it('treats a missing or malformed setting as disabled', () => {
    // Fail towards costing nothing: an absent setting must not turn the readback on.
    for (const bad of [undefined, null, 0, '']) {
      state.settings = { ...getDefaultSettings(), inputs: {}, artnetEnabled: bad }
      syncArtnetFrameObserver()
      expect(frameObserverCount(), String(bad)).toBe(0)
    }
  })

  it('does not throw when settings are not loaded yet', () => {
    state.settings = null
    expect(() => syncArtnetFrameObserver()).not.toThrow()
    expect(frameObserverCount()).toBe(0)
  })
})

describe('the readback is rate-limited in gl-base, not by the observer', () => {
  // projectRoot rather than import.meta.url: under jsdom that is not a file: URL,
  // which the DOM helper documents and exports projectRoot to work around.
  const SRC = readFileSync(
    path.resolve(projectRoot, 'src/renderer/screensavers/gl-base.js'), 'utf8')

  it('gates notifyFrameObservers on an interval', () => {
    // The original called it every frame and documented that observers were
    // "expected to rate-limit itself" -- impossible, since the readback precedes
    // the call. A future edit removing this gate reintroduces the 40x.
    expect(SRC).toMatch(/FRAME_OBSERVER_MIN_INTERVAL_MS/)
    const loop = SRC.slice(SRC.indexOf('if (frameObservers.length)'))
    expect(loop.slice(0, 400)).toMatch(/lastObserverNotify/)
  })

  it('limits to no more often than the consumer can use', () => {
    // Art-Net sends at 1Hz; sampling faster is waste by definition.
    const ms = SRC.match(/FRAME_OBSERVER_MIN_INTERVAL_MS = (\d+)/)
    expect(ms).not.toBeNull()
    expect(Number(ms[1])).toBeGreaterThanOrEqual(1000)
  })
})
