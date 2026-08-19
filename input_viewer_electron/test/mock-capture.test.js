// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Synthetic capture inputs for --mock (#248).
 *
 * jsdom has no canvas backend and no captureStream, so nothing here asserts
 * pixels. What it does assert is the contract the renderer depends on: device
 * ids that cannot collide with real ones, a stop() that releases everything it
 * took, and -- the one with teeth -- that mock mode never writes settings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRendererDom, device } from './helpers/renderer-dom.js'

installRendererDom()

const fakeTrack = () => ({
  stop: vi.fn(),
  getSettings: () => ({ width: 1280, height: 720, frameRate: 15 }),
  getCapabilities: () => ({
    width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 }
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
  mockDeviceList, isMockDeviceId, drawMockFrame, createMockStream,
  MOCK_DEVICE_PREFIX, MOCK_WIDTH, MOCK_HEIGHT,
} = await import('../src/renderer/mock-capture.js')

const {
  state, setInputName, toggleInputEnabled, getDefaultSettings,
} = await import('../src/renderer/renderer.js')

describe('mockDeviceList', () => {
  it('is shaped like enumerateDevices output', () => {
    const [first] = mockDeviceList(1)
    expect(first).toEqual({
      deviceId: `${MOCK_DEVICE_PREFIX}1`,
      kind: 'videoinput',
      label: 'Mock Input 1',
      groupId: 'mock-group-1',
    })
  })

  it('numbers inputs from 1, matching the 1-4 shortcut keys', () => {
    expect(mockDeviceList(4).map(d => d.label)).toEqual([
      'Mock Input 1', 'Mock Input 2', 'Mock Input 3', 'Mock Input 4',
    ])
  })

  it('gives each input its own groupId', () => {
    // Real capture cards report one groupId per physical unit and the renderer
    // pairs audio by it (#151). Sharing a groupId across mock inputs would make
    // that pairing look right in mock mode while being wrong for hardware.
    const ids = mockDeviceList(4).map(d => d.groupId)
    expect(new Set(ids).size).toBe(4)
  })

  it('always yields at least one input', () => {
    for (const bad of [0, -3, NaN, undefined]) {
      expect(mockDeviceList(bad)).toHaveLength(1)
    }
  })
})

describe('isMockDeviceId', () => {
  it('recognises its own ids and nothing else', () => {
    expect(isMockDeviceId(`${MOCK_DEVICE_PREFIX}1`)).toBe(true)
    expect(isMockDeviceId('mock')).toBe(false)
    // A real macOS capture id: a long hash. Must never be taken for a mock.
    expect(isMockDeviceId('3b1f8e0c9a2d4e5f6071829384a5b6c7d8e9f0a1')).toBe(false)
    expect(isMockDeviceId(undefined)).toBe(false)
    expect(isMockDeviceId(null)).toBe(false)
    expect(isMockDeviceId(42)).toBe(false)
  })
})

describe('drawMockFrame', () => {
  const spyCtx = () => ({
    fillStyle: '', font: '', globalAlpha: 1,
    fillRect: vi.fn(), fillText: vi.fn(),
  })

  it('draws colour bars, a sweep and the label when live', () => {
    const ctx = spyCtx()
    drawMockFrame(ctx, {
      width: 1280, height: 720, label: 'Mock Input 2', phase: 0.5, still: false,
    })
    // Seven bars, the base under them, and the sweep.
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(9)
    expect(ctx.fillText).toHaveBeenCalledWith('Mock Input 2', expect.any(Number), expect.any(Number))
  })

  it('resets globalAlpha after the translucent sweep', () => {
    // Leaked alpha would make the label ghosted, and this context is reused for
    // every subsequent frame.
    const ctx = spyCtx()
    drawMockFrame(ctx, {
      width: 1280, height: 720, label: 'x', phase: 0.2, still: false,
    })
    expect(ctx.globalAlpha).toBe(1)
  })

  it('moves the sweep with the phase', () => {
    const xAt = (phase) => {
      const ctx = spyCtx()
      drawMockFrame(ctx, { width: 1000, height: 500, label: 'x', phase, still: false })
      // The sweep is the only full-height fillRect.
      const sweep = ctx.fillRect.mock.calls.find(([, y, , h]) => y === 0 && h === 500)
      return sweep[0]
    }
    expect(xAt(0.75)).toBeGreaterThan(xAt(0.25))
  })

  it('draws a dead-input card when still, with no sweep', () => {
    const ctx = spyCtx()
    drawMockFrame(ctx, {
      width: 1280, height: 720, label: 'Mock Input 1', phase: 0.5, still: true,
    })
    // One background fill only.
    expect(ctx.fillRect).toHaveBeenCalledTimes(1)
    expect(ctx.fillText.mock.calls[0][0]).toBe('Mock Input 1 - no source')
  })

  it('tolerates a null context rather than throwing', () => {
    // getContext returns null under a lost context; a draw loop must not die.
    expect(() => drawMockFrame(null, {
      width: 1, height: 1, label: 'x', phase: 0, still: false,
    })).not.toThrow()
  })
})

describe('createMockStream', () => {
  let captured

  beforeEach(() => {
    captured = []
    // jsdom has no captureStream; stand one in that records the fps asked for.
    globalThis.HTMLCanvasElement.prototype.captureStream = function (fps) {
      const tracks = [fakeTrack()]
      const stream = {
        fps,
        getTracks: () => tracks,
        getVideoTracks: () => tracks,
        getAudioTracks: () => [],
      }
      captured.push(stream)
      return stream
    }
  })

  afterEach(() => {
    delete globalThis.HTMLCanvasElement.prototype.captureStream
  })

  it('returns a stream at the mock frame rate', () => {
    const mock = createMockStream({ label: 'Mock Input 1' })
    expect(captured).toHaveLength(1)
    expect(mock.stream.fps).toBe(15)
    mock.stop()
  })

  it('paints the first frame before capturing, so no frame is ever blank', () => {
    // captureStream on a never-drawn canvas yields a transparent first frame,
    // which reads on the wall as a failure to start rather than as mock mode.
    const drawn = []
    const orig = globalThis.HTMLCanvasElement.prototype.getContext
    globalThis.HTMLCanvasElement.prototype.getContext = function (type) {
      const ctx = orig.call(this, type)
      if (ctx) ctx.fillRect = (...a) => drawn.push(a)
      return ctx
    }
    const mock = createMockStream({ label: 'Mock Input 1' })
    expect(drawn.length).toBeGreaterThan(0)
    mock.stop()
    globalThis.HTMLCanvasElement.prototype.getContext = orig
  })

  it('stops the tracks and the draw loop', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const mock = createMockStream({ label: 'Mock Input 1' })
    const [track] = mock.stream.getTracks()
    mock.stop()
    expect(track.stop).toHaveBeenCalled()
    // An abandoned rAF loop drawing into a detached canvas would grow for as
    // long as the app runs, and the renderer replaces streams on every switch.
    expect(cancel).toHaveBeenCalled()
    cancel.mockRestore()
  })

  it('runs no draw loop for a still input', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    const mock = createMockStream({ label: 'Mock Input 1', still: true })
    expect(raf).not.toHaveBeenCalled()
    mock.stop()
    raf.mockRestore()
  })

  it('defaults to the documented capture size', () => {
    const mock = createMockStream({ label: 'x' })
    expect([MOCK_WIDTH, MOCK_HEIGHT]).toEqual([1280, 720])
    mock.stop()
  })

  it('fails with a clear message where captureStream is unavailable', () => {
    delete globalThis.HTMLCanvasElement.prototype.captureStream
    expect(() => createMockStream({ label: 'x' })).toThrow(/captureStream/)
  })
})

describe('mock mode never writes settings', () => {
  // The guard that stops a test run from damaging the wall's configuration:
  // without it, one --mock launch persists mock-input-N as the default input and
  // the next production launch starts on a device that will never exist.
  let saveSpy

  beforeEach(() => {
    saveSpy = vi.fn(async () => true)
    globalThis.window.electronAPI = { saveSettings: saveSpy }
    state.settings = { ...getDefaultSettings(), inputs: {} }
    state.devices = [device('cam1')]
    state.leftDeviceId = 'cam1'
    state.rightDeviceId = 'cam1'
  })

  afterEach(() => {
    delete globalThis.window.electronAPI
    state.testFlags = {
      mock: false, mockInputs: 0, noSignal: false, screensaverDelayMs: null,
    }
  })

  it('persists a rename in a normal run', () => {
    state.testFlags = {
      mock: false, mockInputs: 0, noSignal: false, screensaverDelayMs: null,
    }
    setInputName('cam1', 'Podium')
    expect(saveSpy).toHaveBeenCalled()
  })

  it('does not persist a rename under --mock', () => {
    state.testFlags = {
      mock: true, mockInputs: 4, noSignal: false, screensaverDelayMs: null,
    }
    setInputName('cam1', 'Podium')
    // In-memory change still applies, so the dropdown behaves normally.
    expect(state.settings.inputs.cam1.name).toBe('Podium')
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('does not persist an enable/disable toggle under --mock', () => {
    state.testFlags = {
      mock: true, mockInputs: 4, noSignal: false, screensaverDelayMs: null,
    }
    toggleInputEnabled('cam1')
    expect(saveSpy).not.toHaveBeenCalled()
  })
})
