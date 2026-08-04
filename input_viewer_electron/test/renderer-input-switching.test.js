// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tests for the renderer's input-switching and layout state logic -- the
 * behaviour behind the D/S view keys, the 1-4 input keys and the freeze key.
 *
 * These drive the real functions from renderer.js against a jsdom DOM rather
 * than a reimplementation, so they fail if the production logic changes.
 * getUserMedia is stubbed: startVideoStream is called on the happy path and
 * would otherwise reject, and we care about the state transition, not the
 * stream itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installRendererDom, device } from './helpers/renderer-dom.js'

installRendererDom()

// Stub the capture pipeline before importing: renderer.js reads
// navigator.mediaDevices at call time, so this only needs to exist by then.
const fakeTrack = () => ({ stop: vi.fn(), getSettings: () => ({}) })
const fakeStream = () => ({
  getTracks: () => [fakeTrack()],
  getVideoTracks: () => [fakeTrack()],
  getAudioTracks: () => [],
})
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => fakeStream()),
    enumerateDevices: vi.fn(async () => []),
  },
  configurable: true,
})

const {
  state, elements, setLayout, selectInput, toggleFreeze,
  getInputName, isInputEnabled, setInputName, toggleInputEnabled,
  getDefaultSettings, setCenterGap, setBorderWidth,
} = await import('../src/renderer/renderer.js')

// Reset the shared module state between tests. renderer.js keeps one `state`
// object for the app's lifetime, so each test has to put it back.
function resetState({ devices = [], inputs = {} } = {}) {
  state.settings = { ...getDefaultSettings(), inputs }
  state.devices = devices
  state.leftDeviceId = null
  state.rightDeviceId = null
  state.leftStream = null
  state.rightStream = null
  state.layoutMode = 'dual'
  state.frozen = false
  state.centerGap = 60
  state.borderWidth = 0
}

beforeEach(() => {
  vi.clearAllMocks()
  resetState()
})

describe('isInputEnabled', () => {
  it('defaults to enabled for an input with no saved settings', () => {
    resetState()
    expect(isInputEnabled('unknown-device')).toBe(true)
  })

  it('honours an explicit false', () => {
    resetState({ inputs: { cam1: { enabled: false } } })
    expect(isInputEnabled('cam1')).toBe(false)
  })

  it('ignores a non-boolean enabled and falls back to enabled', () => {
    // Guards against a hand-edited settings.json putting a string here.
    resetState({ inputs: { cam1: { enabled: 'nope' } } })
    expect(isInputEnabled('cam1')).toBe(true)
  })
})

describe('getInputName', () => {
  it('falls back to the supplied default when unnamed', () => {
    resetState()
    expect(getInputName('cam1', 'Input 1')).toBe('Input 1')
  })

  it('prefers a saved custom name', () => {
    resetState({ inputs: { cam1: { name: 'Laptop', enabled: true } } })
    expect(getInputName('cam1', 'Input 1')).toBe('Laptop')
  })

  it('falls back when the saved name is empty', () => {
    resetState({ inputs: { cam1: { name: '', enabled: true } } })
    expect(getInputName('cam1', 'Input 1')).toBe('Input 1')
  })
})

describe('setInputName / toggleInputEnabled', () => {
  it('creates the settings entry for a previously unknown input', () => {
    resetState()
    setInputName('newcam', 'Desk')
    expect(state.settings.inputs.newcam).toMatchObject({ name: 'Desk', enabled: true })
  })

  it('toggles an unknown input to disabled without losing the name slot', () => {
    resetState()
    toggleInputEnabled('newcam')
    expect(state.settings.inputs.newcam.enabled).toBe(false)
  })

  it('round-trips back to enabled', () => {
    resetState({ inputs: { cam1: { enabled: true, name: 'A' } } })
    toggleInputEnabled('cam1')
    expect(isInputEnabled('cam1')).toBe(false)
    toggleInputEnabled('cam1')
    expect(isInputEnabled('cam1')).toBe(true)
    // Renaming must survive a disable/enable cycle.
    expect(getInputName('cam1', 'fallback')).toBe('A')
  })
})

describe('setLayout', () => {
  it('switches to single view and records it in state and settings', () => {
    resetState()
    setLayout('single')
    expect(state.layoutMode).toBe('single')
    expect(state.settings.layoutMode).toBe('single')
    expect(document.body.classList.contains('single-view')).toBe(true)
    expect(elements.rightFeed.classList.contains('hidden')).toBe(true)
  })

  it('switches back to dual view and unhides the right feed', () => {
    resetState()
    setLayout('single')
    setLayout('dual')
    expect(state.layoutMode).toBe('dual')
    expect(document.body.classList.contains('single-view')).toBe(false)
    expect(elements.rightFeed.classList.contains('hidden')).toBe(false)
  })

  it('marks the matching view-mode button active', () => {
    resetState()
    setLayout('single')
    expect(elements.viewModeSingle.classList.contains('active')).toBe(true)
    expect(elements.viewModeDual.classList.contains('active')).toBe(false)
    setLayout('dual')
    expect(elements.viewModeDual.classList.contains('active')).toBe(true)
    expect(elements.viewModeSingle.classList.contains('active')).toBe(false)
  })
})

describe('selectInput', () => {
  const three = [device('cam1'), device('cam2'), device('cam3')]

  it('selects by zero-based index across both sides', async () => {
    resetState({ devices: three })
    await selectInput(0)
    expect(state.leftDeviceId).toBe('cam1')
    expect(state.rightDeviceId).toBe('cam1')
  })

  it('targets a single side when asked', async () => {
    resetState({ devices: three })
    await selectInput(1, 'left')
    expect(state.leftDeviceId).toBe('cam2')
    expect(state.rightDeviceId).toBe(null)

    await selectInput(2, 'right')
    expect(state.leftDeviceId).toBe('cam2')
    expect(state.rightDeviceId).toBe('cam3')
  })

  it('indexes over enabled devices only, skipping disabled ones', async () => {
    // This is the subtle one: index 1 is cam3, not cam2, because cam2 is
    // filtered out before indexing. Pressing "2" must land on the second
    // *visible* input.
    resetState({ devices: three, inputs: { cam2: { enabled: false } } })
    await selectInput(1)
    expect(state.leftDeviceId).toBe('cam3')
  })

  it('ignores an out-of-range index without changing state', async () => {
    resetState({ devices: three })
    await selectInput(9)
    expect(state.leftDeviceId).toBe(null)
    expect(state.rightDeviceId).toBe(null)
  })

  it('ignores a negative index', async () => {
    resetState({ devices: three })
    await selectInput(-1)
    expect(state.leftDeviceId).toBe(null)
  })

  it('is a no-op when every device is disabled', async () => {
    resetState({
      devices: three,
      inputs: { cam1: { enabled: false }, cam2: { enabled: false }, cam3: { enabled: false } },
    })
    await selectInput(0)
    expect(state.leftDeviceId).toBe(null)
  })

  it('is a no-op when no devices are present at all', async () => {
    resetState({ devices: [] })
    await selectInput(0)
    expect(state.leftDeviceId).toBe(null)
  })

  it('shows the custom name when one is set', async () => {
    resetState({ devices: three, inputs: { cam1: { name: 'Laptop', enabled: true } } })
    await selectInput(0)
    expect(elements.inputNameText.textContent).toBe('Laptop')
  })
})

describe('toggleFreeze', () => {
  it('toggles the frozen flag on and off', () => {
    resetState()
    expect(state.frozen).toBe(false)
    toggleFreeze()
    expect(state.frozen).toBe(true)
    toggleFreeze()
    expect(state.frozen).toBe(false)
  })

  it('shows a FROZEN badge while frozen', () => {
    resetState()
    toggleFreeze()
    expect(elements.freezeIndicator.classList.contains('hidden')).toBe(false)
    expect(elements.freezeIndicator.classList.contains('frozen')).toBe(true)
    expect(elements.freezeIndicator.textContent).toContain('FROZEN')
    expect(elements.freezeOverlay.classList.contains('hidden')).toBe(false)
  })

  it('swaps to a transient LIVE badge on unfreeze, then hides it after 1s', () => {
    vi.useFakeTimers()
    try {
      resetState()
      toggleFreeze()
      toggleFreeze()
      // The overlay goes immediately, but the indicator lingers as "LIVE".
      expect(elements.freezeOverlay.classList.contains('hidden')).toBe(true)
      expect(elements.freezeIndicator.classList.contains('hidden')).toBe(false)
      expect(elements.freezeIndicator.classList.contains('frozen')).toBe(false)
      expect(elements.freezeIndicator.textContent).toContain('LIVE')

      vi.advanceTimersByTime(1000)
      expect(elements.freezeIndicator.classList.contains('hidden')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores video opacity when unfrozen', () => {
    resetState()
    toggleFreeze()
    expect(elements.leftVideo.style.opacity).toBe('0')
    toggleFreeze()
    expect(elements.leftVideo.style.opacity).toBe('1')
  })
})

describe('setCenterGap / setBorderWidth', () => {
  it('records the gap in state and settings', () => {
    resetState()
    setCenterGap(120)
    expect(state.centerGap).toBe(120)
    expect(state.settings.centerGap).toBe(120)
    expect(elements.centerDivider.style.width).toBe('120px')
  })

  it('records the border width in state and settings', () => {
    resetState()
    setBorderWidth(40)
    expect(state.borderWidth).toBe(40)
    expect(state.settings.borderWidth).toBe(40)
  })

  it('accepts zero without falling back to a default', () => {
    resetState()
    setCenterGap(0)
    expect(state.centerGap).toBe(0)
    setBorderWidth(0)
    expect(state.borderWidth).toBe(0)
  })
})

describe('getDefaultSettings', () => {
  it('provides the documented defaults', () => {
    const d = getDefaultSettings()
    expect(d.centerGap).toBe(60)
    expect(d.borderWidth).toBe(0)
    expect(d.inputs).toEqual({})
    // null (not 'dual') so init() can fall back to aspect-ratio detection.
    expect(d.layoutMode).toBe(null)
  })

  it('returns a fresh object each call so callers cannot poison the defaults', () => {
    const a = getDefaultSettings()
    a.inputs.cam1 = { enabled: false }
    expect(getDefaultSettings().inputs).toEqual({})
  })
})
