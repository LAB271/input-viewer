// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * A split-flap board runs only while it is the top thing on its side.
 *
 * Nothing used to stop them when the screensaver took over. #dvd-overlay is
 * z-index 25 with an opaque black background over the no-signal overlay's 10, so
 * both boards kept rendering at full rate behind it -- two WebGL2 contexts and two
 * frame loops drawing something nobody could see.
 *
 * The frame-rate report had been showing exactly that, three runtimes with two
 * invisible, before anyone noticed.
 *
 * Starting a real board needs WebGL2, which jsdom has none of, so these cover the
 * rule and the wiring: the truth table, and that every transition changing what is
 * on top actually consults it.
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

const { state, getDefaultSettings, boardShouldRun, syncNoSignalBoards } =
  await import('../src/renderer/renderer.js')

const RENDERER = readFileSync(
  path.resolve(projectRoot, 'src/renderer/renderer.js'), 'utf8')

beforeEach(() => {
  state.settings = { ...getDefaultSettings(), inputs: {} }
  state.noSignalState.left = false
  state.noSignalState.right = false
  state.testFlags = {
    mock: false, mockInputs: 0, noSignal: false, screensaverDelayMs: null,
  }
})

describe('the rule', () => {
  it('runs a board only when its side is dark and nothing covers it', () => {
    state.noSignalState.left = true
    expect(boardShouldRun('left', false)).toBe(true)
  })

  it('stops it once the screensaver is on top', () => {
    // The whole bug: an opaque overlay above, two boards still drawing below.
    state.noSignalState.left = true
    expect(boardShouldRun('left', true)).toBe(false)
  })

  it('does not run a board for a side that has signal', () => {
    state.noSignalState.left = false
    expect(boardShouldRun('left', false)).toBe(false)
  })

  it('covers the full truth table', () => {
    for (const dark of [true, false]) {
      for (const saverUp of [true, false]) {
        state.noSignalState.left = dark
        expect(boardShouldRun('left', saverUp), `dark=${dark} saver=${saverUp}`)
          .toBe(dark && !saverUp)
      }
    }
  })

  it('decides each side independently', () => {
    // One side can be dark while the other carries signal.
    state.noSignalState.left = true
    state.noSignalState.right = false
    expect(boardShouldRun('left', false)).toBe(true)
    expect(boardShouldRun('right', false)).toBe(false)
  })

  it('returns a boolean even from a missing state entry', () => {
    delete state.noSignalState.left
    expect(boardShouldRun('left', false)).toBe(false)
  })
})

describe('every transition that changes what is on top consults it', () => {
  // Four paths have to agree, and the failure mode of one being missed is silent:
  // a board left running invisibly, or a side stuck showing nothing after the
  // saver goes away. Asserted against the source because the GL lifecycle is not
  // reachable here.
  const bodyOf = (fnName) => {
    const at = RENDERER.indexOf(`function ${fnName}(`)
    expect(at, `${fnName} not found`).toBeGreaterThan(-1)
    return RENDERER.slice(at, RENDERER.indexOf('\n}\n', at))
  }

  it('signal lost -> showNoSignal', () => {
    // Not startNoSignalBoard directly: if a saver is already up because the OTHER
    // side dropped first, this side's board must not start.
    expect(bodyOf('showNoSignal')).toContain('syncNoSignalBoards()')
    expect(bodyOf('showNoSignal')).not.toMatch(/\bstartNoSignalBoard\(/)
  })

  it('screensaver arriving -> showDvdScreensaver', () => {
    expect(bodyOf('showDvdScreensaver')).toContain('syncNoSignalBoards()')
  })

  it('screensaver leaving -> hideDvdScreensaver', () => {
    // Reachable via V while still dark, not only via signal returning.
    expect(bodyOf('hideDvdScreensaver')).toContain('syncNoSignalBoards()')
  })

  it('signal restored -> hideNoSignal still stops its own board', () => {
    expect(bodyOf('hideNoSignal')).toMatch(/stopNoSignalBoard\(/)
  })
})

describe('syncNoSignalBoards is safe to call in this environment', () => {
  it('does not throw with no board canvas present', () => {
    // The DOM fixture has the overlay but no .no-signal-board canvas, which is the
    // same shape as a real overlay before one is created.
    state.noSignalState.left = true
    state.noSignalState.right = true
    expect(() => syncNoSignalBoards()).not.toThrow()
  })

  it('is idempotent', () => {
    state.noSignalState.left = true
    expect(() => { syncNoSignalBoards(); syncNoSignalBoards() }).not.toThrow()
  })
})
