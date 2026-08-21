// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Live state on the split-flap board (#154).
 *
 * The board cycled a static word list. It now shows the selected input, NO SIGNAL,
 * and how long the feed has been down -- pushed in from the renderer, which keeps
 * all knowledge of inputs and sides out of the saver.
 *
 * The parts worth pinning are the ones that fail quietly: a malformed push leaving
 * a board of blanks, a label longer than the grid being clipped without a mark (the
 * exact bug #92 fixed), and a repeated showNoSignal() resetting the clock so the
 * downtime line never advances.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const splitFlap = (await import('../src/renderer/screensavers/split-flap.js')).default
const { isValidMessageSets, fitLine } =
  await import('../src/renderer/screensavers/split-flap.js')
const {
  state, getDefaultSettings, formatDowntime, boardRowsFor, showNoSignal, hideNoSignal,
} = await import('../src/renderer/renderer.js')

function reset(devices = [device('cam1', 'HDMI 01')]) {
  state.settings = { ...getDefaultSettings(), inputs: {} }
  state.devices = devices
  state.leftDeviceId = devices[0]?.deviceId ?? null
  state.rightDeviceId = devices[1]?.deviceId ?? devices[0]?.deviceId ?? null
  state.layoutMode = 'dual'
  state.noSignalState.left = false
  state.noSignalState.right = false
  state.noSignalSince.left = null
  state.noSignalSince.right = null
  state.testFlags = {
    mock: false, mockInputs: 0, noSignal: false, screensaverDelayMs: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('formatDowntime', () => {
  it('shows minutes and seconds under an hour', () => {
    expect(formatDowntime(0)).toBe('DOWN 00:00')
    expect(formatDowntime(31_000)).toBe('DOWN 00:31')
    expect(formatDowntime(271_000)).toBe('DOWN 04:31')
    expect(formatDowntime(3_599_000)).toBe('DOWN 59:59')
  })

  it('switches to hours at exactly one hour', () => {
    // The boundary, because 60:00 and 1H 00M are both defensible and only one is
    // what the next branch produces.
    expect(formatDowntime(3_600_000)).toBe('DOWN 1H 00M')
    expect(formatDowntime(8_040_000)).toBe('DOWN 2H 14M')
  })

  it('switches to days at exactly 24 hours', () => {
    expect(formatDowntime(86_400_000)).toBe('DOWN 1D 00H')
    expect(formatDowntime(273_600_000)).toBe('DOWN 3D 04H')
  })

  it('never renders a negative clock', () => {
    // A clock read before the start instant would otherwise print DOWN -0:-1.
    expect(formatDowntime(-5000)).toBe('DOWN 00:00')
  })

  it('uses only characters the board can render', () => {
    const CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:'
    for (const ms of [0, 271_000, 3_600_000, 273_600_000]) {
      for (const ch of formatDowntime(ms)) {
        expect(CHARS.includes(ch), `${ch} in "${formatDowntime(ms)}"`).toBe(true)
      }
    }
  })
})

describe('boardRowsFor', () => {
  it('names the input, states no signal, and shows the clock', () => {
    reset()
    state.noSignalSince.left = 1000
    expect(boardRowsFor('left', 1000 + 271_000))
      .toEqual([['HDMI 01', 'NO SIGNAL', 'DOWN 04:31']])
  })

  it('prefers the operator\'s custom name over the device label', () => {
    reset()
    state.settings.inputs.cam1 = { name: 'PODIUM', enabled: true }
    state.noSignalSince.left = 0
    expect(boardRowsFor('left', 0)[0][0]).toBe('PODIUM')
  })

  it('omits the clock when the side is not marked down', () => {
    // Reachable: a board can exist for a side whose stream simply never started.
    reset()
    expect(boardRowsFor('left', 0)).toEqual([['HDMI 01', 'NO SIGNAL']])
  })

  it('returns null with no device, so the static list stays', () => {
    reset([])
    expect(boardRowsFor('left')).toBeNull()
  })

  it('reads each side independently', () => {
    reset([device('cam1', 'HDMI 01'), device('cam2', 'HDMI 02')])
    state.noSignalSince.left = 0
    state.noSignalSince.right = 0
    expect(boardRowsFor('left', 60_000)[0][0]).toBe('HDMI 01')
    expect(boardRowsFor('right', 60_000)[0][0]).toBe('HDMI 02')
  })
})

describe('the downtime clock', () => {
  it('starts on the transition into no-signal', () => {
    reset()
    expect(state.noSignalSince.left).toBeNull()
    showNoSignal('left')
    expect(state.noSignalSince.left).not.toBeNull()
  })

  it('is NOT restarted by a repeated showNoSignal', () => {
    // The bug this guards: showNoSignal is idempotent and is called again for a
    // synced same-device pair and on every re-entry. Restarting the clock each
    // time would peg the downtime line near zero forever, which looks like it
    // works and never advances.
    reset()
    showNoSignal('left')
    const first = state.noSignalSince.left
    showNoSignal('left')
    showNoSignal('left')
    expect(state.noSignalSince.left).toBe(first)
  })

  it('clears when signal returns, so the next outage counts from zero', () => {
    reset()
    showNoSignal('left')
    hideNoSignal('left')
    expect(state.noSignalSince.left).toBeNull()
  })

  it('tracks the two sides separately', () => {
    reset([device('cam1'), device('cam2')])
    showNoSignal('left')
    expect(state.noSignalSince.left).not.toBeNull()
    expect(state.noSignalSince.right).toBeNull()
  })
})

describe('fitLine', () => {
  it('leaves a line that fits alone', () => {
    expect(fitLine('NO SIGNAL', 16)).toBe('NO SIGNAL')
  })

  it('upper-cases, since the glyph set has no lower case', () => {
    expect(fitLine('Podium Laptop', 20)).toBe('PODIUM LAPTOP')
  })

  it('marks a truncation instead of clipping silently', () => {
    // Silent clipping is the exact failure #92 fixed -- "NO SIGNAL" as "NO SIGNA"
    // reads as a broken renderer, not as an abbreviated label.
    const out = fitLine('BLACKMAGIC ULTRASTUDIO RECORDER', 12)
    expect(out).toHaveLength(12)
    expect(out.endsWith('.')).toBe(true)
    expect(out).toBe('BLACKMAGIC .')
  })

  it('survives degenerate widths and empty input', () => {
    expect(fitLine('ABC', 1)).toBe('.')
    expect(fitLine('ABC', 0)).toBe('')
    expect(fitLine('', 10)).toBe('')
    expect(fitLine(null, 10)).toBe('')
    expect(fitLine(undefined, 10)).toBe('')
  })
})

describe('isValidMessageSets', () => {
  it('accepts what boardRowsFor produces', () => {
    reset()
    state.noSignalSince.left = 0
    expect(isValidMessageSets(boardRowsFor('left', 1000))).toBe(true)
  })

  it('rejects everything that would blank the board', () => {
    for (const bad of [
      null, undefined, [], {}, 'rows', 42,
      [[]],                       // a set with no rows
      [['A'], null],              // a null set among valid ones
      [[1, 2, 3]],                // non-strings
      [['A', 'B', 'C', 'D']],     // more rows than the board has
    ]) {
      expect(isValidMessageSets(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('the board accepts pushed rows', () => {
  // create() touches no GL -- the context is claimed in start() -- so the message
  // API is reachable in jsdom even though rendering is not.
  it('takes rows before start() without throwing', () => {
    const board = splitFlap.create(document.createElement('canvas'), 7)
    expect(() => board.setMessages([['HDMI 01', 'NO SIGNAL', 'DOWN 00:12']]))
      .not.toThrow()
  })

  it('ignores a malformed push rather than blanking', () => {
    const board = splitFlap.create(document.createElement('canvas'), 7)
    expect(() => board.setMessages(null)).not.toThrow()
    expect(() => board.setMessages([[123]])).not.toThrow()
  })

  it('exposes setMessages on the board the renderer holds', () => {
    // The renderer feature-detects this; if the API is renamed, that check would
    // silently skip every push rather than fail.
    const board = splitFlap.create(document.createElement('canvas'), 7)
    expect(typeof board.setMessages).toBe('function')
  })
})
