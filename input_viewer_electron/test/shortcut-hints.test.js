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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installRendererDom, device, projectRoot } from './helpers/renderer-dom.js'

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
  renderShortcutLegend, toggleLegend, closeLegend,
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
  // Chips go on the SINGLE-view list only.
  //
  // Not a layout compromise -- a correctness one. `1`-`4` call selectInput() with
  // the default side='both' and set BOTH feeds; clicking a row in the Left column
  // calls selectInputForSide(id, 'left') and sets one. A chip on a per-side row
  // would document a key that does something different from the control beside it.
  // In single view one feed is shown, so setting both and setting that one are the
  // same thing to the operator.
  //
  // It was reported as a fit bug in dual view, and it was that too: a dual column
  // is ~173px against the single list's ~358px.

  it('labels the first four rows of the single-view list with 1-4', () => {
    reset([device('a', 'Cam A'), device('b', 'Cam B'), device('c', 'Cam C'),
      device('d', 'Cam D')])
    renderDropdownInputLists()
    const chips = [...elements.singleInputList.querySelectorAll('kbd')]
      .map(k => k.textContent)
    expect(chips).toEqual(['1', '2', '3', '4'])
  })

  it('puts no chip on the dual columns, where the key means something else', () => {
    reset([device('a', 'Cam A'), device('b', 'Cam B')])
    renderDropdownInputLists()
    expect(elements.leftInputList.querySelectorAll('kbd')).toHaveLength(0)
    expect(elements.rightInputList.querySelectorAll('kbd')).toHaveLength(0)
    // The rows themselves are still there and still named.
    expect([...elements.leftInputList.children].map(r => r.textContent))
      .toEqual(['Cam A', 'Cam B'])
  })

  it('leaves a fifth row unlabelled rather than promising a key', () => {
    reset(['a', 'b', 'c', 'd', 'e'].map(id => device(id, `Cam ${id}`)))
    renderDropdownInputLists()
    const rows = [...elements.singleInputList.children]
    expect(rows).toHaveLength(5)
    expect(rows[4].querySelector('kbd')).toBeNull()
    expect(rows[3].querySelector('kbd').textContent).toBe('4')
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
    const rows = [...elements.singleInputList.children]
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.querySelector('kbd').textContent)).toEqual(['1', '2'])
    expect(rows[1].textContent).toContain('Cam C')
  })

  it('tags each row with its device id, which the sweep finds rows by', () => {
    // paintThumbnail() queries [data-device-id] fresh rather than holding node
    // references, because rows are rebuilt on any device or selection change --
    // which can happen while a snapshot sweep is still running (#242).
    reset([device('a', 'Cam A'), device('b', 'Cam B')])
    renderDropdownInputLists()
    for (const list of [elements.leftInputList, elements.rightInputList,
      elements.singleInputList]) {
      expect([...list.children].map(r => r.dataset.deviceId)).toEqual(['a', 'b'])
    }
  })

  it('renders the snapshot tile before any snapshot exists', () => {
    // The tile is its own placeholder, so a row does not change height when a
    // still lands.
    reset([device('a', 'Cam A')])
    renderDropdownInputLists()
    const tile = elements.leftInputList.querySelector('.input-thumb')
    expect(tile).not.toBeNull()
    expect(tile.classList.contains('has-thumb')).toBe(false)
  })

  it('renders a device label as text, never as markup', () => {
    // Labels come from capture hardware or a user rename. The row is built from
    // elements with textContent for exactly this reason.
    reset([device('a', '<img src=x onerror=alert(1)>')])
    renderDropdownInputLists()
    for (const list of [elements.leftInputList, elements.singleInputList]) {
      const row = list.children[0]
      expect(row.querySelector('img')).toBeNull()
      expect(row.textContent).toContain('<img src=x onerror=alert(1)>')
    }
  })
})

describe('the dual columns cannot overflow the dropdown', () => {
  // The reported bug: with a chip forcing `white-space: nowrap` on the name, the
  // grid's `1fr` tracks -- which are minmax(auto, 1fr), and whose auto minimum is
  // the item's MIN-CONTENT size -- computed to 339.758px each inside a 358px
  // panel. The columns spilled ~320px out of the dropdown.
  //
  // jsdom does no layout, so this asserts the declaration rather than measuring.
  // Both halves of the fix are pinned, because either alone would have hidden it.
  const CSS = readFileSync(
    path.resolve(projectRoot, 'src/renderer/styles.css'), 'utf8')

  const ruleBody = (selector) => {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    const bodies = [...CSS.matchAll(re)].map(m => m[1])
    expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
    return bodies.join('\n')
  }

  it('uses minmax(0, 1fr) so a track can shrink below its content', () => {
    const body = ruleBody('.column-layout')
    expect(body).toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/)
    // A bare `1fr` is the bug.
    expect(body).not.toMatch(/grid-template-columns:\s*1fr\s+1fr/)
  })

  it('scopes name truncation to the list that actually has a chip', () => {
    // Applying nowrap to the dual columns is what pinned the tracks open. Their
    // names wrap, as they did before the chips existed.
    expect(ruleBody('.single-input-option .input-option-name'))
      .toMatch(/white-space:\s*nowrap/)
    expect(CSS).not.toMatch(/^\.input-option-name,/m)
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

describe('the shortcut legend (dropup)', () => {
  // Third consumer of SHORTCUTS, after the keydown handler and the Settings
  // table. Deliberately the same rows as the table rather than a shortened
  // "important ones" set -- that would be a fourth hand-maintained list, which is
  // what #258 existed to remove.

  it('renders one row per shortcut, in list order', () => {
    renderShortcutLegend()
    const rows = [...elements.legendGrid.children]
    expect(rows).toHaveLength(SHORTCUTS.length)
    expect(rows.map(r => r.querySelector('.legend-label').textContent.split(' (')[0]))
      .toEqual(SHORTCUTS.map(s => s.label))
  })

  it('prints each shortcut\'s keys as chips', () => {
    renderShortcutLegend()
    const rows = [...elements.legendGrid.children]
    rows.forEach((row, i) => {
      expect([...row.querySelectorAll('kbd')].map(k => k.textContent), SHORTCUTS[i].id)
        .toEqual(SHORTCUTS[i].chips)
    })
  })

  it('carries the caveat on the remote-keyboard rows', () => {
    renderShortcutLegend()
    const notes = [...elements.legendGrid.querySelectorAll('.legend-note')]
    expect(notes).toHaveLength(SHORTCUTS.filter(s => s.note).length)
    expect(notes[0].textContent).toContain('remote keyboard')
  })

  it('replaces its rows rather than appending on a re-render', () => {
    renderShortcutLegend()
    renderShortcutLegend()
    expect(elements.legendGrid.children).toHaveLength(SHORTCUTS.length)
  })

  it('shows every key the Settings table shows', () => {
    // The two are the same list; if they ever diverge, one of them is a second
    // source of truth again.
    renderShortcutHints()
    renderShortcutLegend()
    const chips = (root) => [...root.querySelectorAll('kbd')].map(k => k.textContent).sort()
    expect(chips(elements.legendGrid)).toEqual(chips(elements.shortcutsTable))
  })
})

describe('opening and closing the legend', () => {
  beforeEach(() => {
    closeLegend()
  })

  it('toggles touch-open on both the trigger and the panel', () => {
    // The CSS opens the panel from either, mirroring the dropdown:
    // `#legend-trigger.touch-open + #legend-panel, #legend-panel.touch-open`.
    toggleLegend()
    expect(elements.legendPanel.classList.contains('touch-open')).toBe(true)
    expect(elements.legendTrigger.classList.contains('touch-open')).toBe(true)

    toggleLegend()
    expect(elements.legendPanel.classList.contains('touch-open')).toBe(false)
    expect(elements.legendTrigger.classList.contains('touch-open')).toBe(false)
  })

  it('tracks state.legendOpen', () => {
    toggleLegend()
    expect(state.legendOpen).toBe(true)
    closeLegend()
    expect(state.legendOpen).toBe(false)
  })

  it('closes on Escape, like the other panels', () => {
    globalThis.window.electronAPI = {
      isFullscreen: async () => false,
      toggleFullscreen: vi.fn(),
    }
    toggleLegend()
    handleKeyDown({ key: 'Escape', target: document.body, preventDefault() {} })
    expect(state.legendOpen).toBe(false)
    delete globalThis.window.electronAPI
  })
})

describe('the legend geometry mirrors the dropdown', () => {
  const CSS = readFileSync(
    path.resolve(projectRoot, 'src/renderer/styles.css'), 'utf8')

  const ruleBody = (selector) => {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
    const bodies = [...CSS.matchAll(re)].map(m => m[1])
    expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
    return bodies.join('\n')
  }

  it('anchors to the bottom edge and hides itself a full height below', () => {
    const body = ruleBody('#legend-panel')
    expect(body).toMatch(/bottom:\s*0/)
    // 100% of its own height, so it is off-screen whatever the row count.
    expect(body).toMatch(/transform:\s*translateX\(-50%\)\s*translateY\(100%\)/)
  })

  it('sets an explicit width, not only a max', () => {
    // A fixed-position element is shrink-to-fit, so `max-width` caps it but never
    // expands it -- and auto-fit needs a DEFINITE width to work out its column
    // count. With only a max it measured 467px and one column at a 1500px
    // viewport, which is the long list this grid exists to avoid.
    const body = ruleBody('#legend-panel')
    expect(body).toMatch(/(^|\s)width:\s*min\(/m)
  })

  it('wraps its columns to the available width', () => {
    expect(ruleBody('.legend-grid'))
      .toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/)
  })

  it('lets labels wrap rather than truncate', () => {
    // Measured at 1100px: three of twelve labels ellipsised, including both
    // "(if the remote keyboard is enabled)" caveats -- the part that makes those
    // rows make sense. A legend that hides what a key does defeats itself.
    const body = ruleBody('.legend-label')
    expect(body).not.toMatch(/text-overflow:\s*ellipsis/)
    expect(body).not.toMatch(/white-space:\s*nowrap/)
  })

  it('gives the key column a fixed width so labels line up', () => {
    const body = ruleBody('.legend-keys')
    expect(body).toMatch(/width:\s*\d+px/)
    expect(body).toMatch(/flex-shrink:\s*0/)
  })
})
