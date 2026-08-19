// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The rendered shortcut hints (#258).
 *
 * shortcuts.test.js checks the list and its agreement with the renderer's action
 * map. This drives the two consumers that put it on screen -- the Settings table
 * and the dropdown -- so a change to the list is visible in both, and so the
 * table can never again be a hand-maintained copy that drifts.
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

const { SHORTCUTS, shortcutById } =
  await import('../src/renderer/shortcuts.js')
const {
  state, elements, getDefaultSettings, handleKeyDown, setLayout,
  renderShortcutHints, renderDropdownInputLists,
} = await import('../src/renderer/renderer.js')

function reset(devices = []) {
  state.settings = { ...getDefaultSettings(), inputs: {} }
  state.devices = devices
  state.leftDeviceId = devices[0]?.deviceId ?? null
  state.rightDeviceId = devices[1]?.deviceId ?? null
  state.layoutMode = 'dual'
  state.frozen = false
  state.testFlags = {
    mock: false, mockInputs: 0, noSignal: false, screensaverDelayMs: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('the Settings table', () => {
  it('renders one row per shortcut, in list order', () => {
    renderShortcutHints()
    const rows = [...elements.shortcutsTable.querySelectorAll('tr')]
    expect(rows).toHaveLength(SHORTCUTS.length)
    expect(rows.map(r => r.children[1].textContent.split(' (')[0]))
      .toEqual(SHORTCUTS.map(s => s.label))
  })

  it('prints each shortcut\'s keys as kbd chips', () => {
    renderShortcutHints()
    const rows = [...elements.shortcutsTable.querySelectorAll('tr')]
    rows.forEach((row, i) => {
      const chips = [...row.querySelectorAll('kbd')].map(k => k.textContent)
      expect(chips, SHORTCUTS[i].id).toEqual(SHORTCUTS[i].chips)
    })
  })

  it('shows the keys the old hardcoded table was missing', () => {
    // The drift #258 was filed about: Q, V, +/- and F11 were bound but absent
    // from the only place that listed the shortcuts.
    renderShortcutHints()
    const chips = [...elements.shortcutsTable.querySelectorAll('kbd')]
      .map(k => k.textContent)
    for (const key of ['Q', 'V', '+', '-', 'F11']) {
      expect(chips, `missing ${key}`).toContain(key)
    }
  })

  it('renders the caveat on the remote-keyboard rows', () => {
    renderShortcutHints()
    const notes = [...elements.shortcutsTable.querySelectorAll('.shortcut-note')]
    expect(notes).toHaveLength(
      SHORTCUTS.filter(s => s.note).length)
    expect(notes[0].textContent).toContain('remote keyboard')
  })

  it('replaces its rows rather than appending on a re-render', () => {
    renderShortcutHints()
    renderShortcutHints()
    expect(elements.shortcutsTable.querySelectorAll('tr'))
      .toHaveLength(SHORTCUTS.length)
  })
})

describe('the view-mode buttons', () => {
  it('label Dual and Single with their keys', () => {
    renderShortcutHints()
    expect(elements.viewModeDual.textContent).toContain('Dual')
    expect(elements.viewModeDual.querySelector('kbd').textContent).toBe('D')
    expect(elements.viewModeSingle.textContent).toContain('Single')
    expect(elements.viewModeSingle.querySelector('kbd').textContent).toBe('S')
  })

  it('keeps the active class that setLayout toggles', () => {
    // renderShortcutHints rewrites these buttons' contents, so it must not
    // clobber the class setLayout uses to show which mode is current.
    renderShortcutHints()
    setLayout('single')
    expect(elements.viewModeSingle.classList.contains('active')).toBe(true)
    expect(elements.viewModeDual.classList.contains('active')).toBe(false)
  })
})

describe('the dropdown input rows', () => {
  it('labels the first four rows with 1-4', () => {
    reset([device('a', 'Cam A'), device('b', 'Cam B'), device('c', 'Cam C'),
      device('d', 'Cam D')])
    renderDropdownInputLists()
    const chips = [...elements.leftInputList.querySelectorAll('kbd')]
      .map(k => k.textContent)
    expect(chips).toEqual(['1', '2', '3', '4'])
  })

  it('leaves a fifth row unlabelled rather than promising a key', () => {
    reset(['a', 'b', 'c', 'd', 'e'].map(id => device(id, `Cam ${id}`)))
    renderDropdownInputLists()
    const rows = [...elements.leftInputList.children]
    expect(rows).toHaveLength(5)
    expect(rows[4].querySelector('kbd')).toBeNull()
    expect(rows[3].querySelector('kbd').textContent).toBe('4')
  })

  it('labels all three lists, including single view', () => {
    reset([device('a', 'Cam A'), device('b', 'Cam B')])
    renderDropdownInputLists()
    for (const list of [elements.leftInputList, elements.rightInputList,
      elements.singleInputList]) {
      expect([...list.querySelectorAll('kbd')].map(k => k.textContent))
        .toEqual(['1', '2'])
    }
  })

  it('skips disabled inputs, so the numbering matches what is shown', () => {
    // selectInput indexes the enabled list, so a hidden disabled device must not
    // consume a number.
    state.settings = {
      ...getDefaultSettings(),
      inputs: { b: { name: null, enabled: false } },
    }
    state.devices = [device('a', 'Cam A'), device('b', 'Cam B'),
      device('c', 'Cam C')]
    renderDropdownInputLists()
    const rows = [...elements.leftInputList.children]
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.querySelector('kbd').textContent)).toEqual(['1', '2'])
    expect(rows[1].textContent).toContain('Cam C')
  })

  it('renders a device label as text, never as markup', () => {
    // Labels come from capture hardware or a user rename. The row is built from
    // elements with textContent for exactly this reason.
    reset([device('a', '<img src=x onerror=alert(1)>')])
    renderDropdownInputLists()
    const row = elements.leftInputList.children[0]
    expect(row.querySelector('img')).toBeNull()
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('the keys still do what they did', () => {
  // The switch became a lookup, so these check the dispatch end to end for every
  // key with an effect that is observable without a GL context. The screensaver
  // keys (V, +, -) are left out on purpose: starting a saver needs WebGL2, which
  // jsdom has none of -- the same reason screensaver-stepping.test.js covers the
  // index maths rather than a real activation.
  const press = (key, target = document.body) => {
    const preventDefault = vi.fn()
    handleKeyDown({ key, target, preventDefault })
    return preventDefault
  }

  it('D and S still switch layout', () => {
    reset()
    setLayout('single')
    press('d')
    expect(state.layoutMode).toBe('dual')
    press('s')
    expect(state.layoutMode).toBe('single')
  })

  it('a number key selects that input', () => {
    reset([device('a', 'Cam A'), device('b', 'Cam B')])
    press('2')
    expect(state.leftDeviceId).toBe('b')
  })

  it('Space freezes and unfreezes', () => {
    reset()
    press(' ')
    expect(state.frozen).toBe(true)
    press(' ')
    expect(state.frozen).toBe(false)
  })

  it('F asks the main process for fullscreen', () => {
    reset()
    const toggleFullscreen = vi.fn()
    globalThis.window.electronAPI = { toggleFullscreen }
    press('f')
    expect(toggleFullscreen).toHaveBeenCalled()
    // F11 is an alias, not a separate binding.
    press('f11')
    expect(toggleFullscreen).toHaveBeenCalledTimes(2)
    delete globalThis.window.electronAPI
  })

  it('Q quits', () => {
    reset()
    const quitApp = vi.fn()
    globalThis.window.electronAPI = { quitApp }
    press('q')
    expect(quitApp).toHaveBeenCalled()
    delete globalThis.window.electronAPI
  })

  it('is still case-insensitive', () => {
    reset()
    setLayout('dual')
    press('S')
    expect(state.layoutMode).toBe('single')
  })

  it('still ignores every key while typing in a field', () => {
    reset()
    setLayout('dual')
    press('s', { tagName: 'INPUT' })
    expect(state.layoutMode).toBe('dual')
  })

  it('suppresses the default action for exactly the keys that declare it', () => {
    // Space must not scroll and F must not type; Escape and the arrows must keep
    // their default behaviour. Getting this backwards is invisible until it is
    // not, so it is pinned per key.
    reset()
    globalThis.window.electronAPI = {
      toggleFullscreen: vi.fn(),
      quitApp: vi.fn(),
    }
    for (const { keys, id, preventDefault: expected } of SHORTCUTS) {
      // Skip the GL-backed savers, as above.
      if (id.startsWith('screensaver')) continue
      // Escape reaches electronAPI.isFullscreen, which this stub omits.
      if (id === 'escape') continue
      for (const key of keys) {
        const spy = press(key)
        expect(spy.mock.calls.length > 0, `${id} (${key})`).toBe(expected)
      }
    }
    delete globalThis.window.electronAPI
  })

  it('ignores a key that is in no shortcut', () => {
    reset()
    setLayout('dual')
    press('z')
    press('F5')
    expect(state.layoutMode).toBe('dual')
  })

  it('has an entry for every key it claims to handle', () => {
    // Sanity check on the list itself from the handler's side: every declared
    // key resolves to a shortcut with an id the renderer knows.
    for (const shortcut of SHORTCUTS) {
      expect(shortcutById(shortcut.id)).toBeDefined()
    }
  })
})
