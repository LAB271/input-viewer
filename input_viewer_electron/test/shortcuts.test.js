// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The shared shortcut list (#258).
 *
 * The list exists because there used to be two: the switch in renderer.js and a
 * hardcoded table in index.html, which had already drifted -- it was missing Q,
 * V, +/- and F11. Nothing failed when that happened; the table was just quietly
 * wrong. So the tests that matter here are the ones that make a future drift
 * fail loudly:
 *
 *   - every entry has an action in the renderer, and every action an entry
 *   - no two entries claim the same key
 *   - the keys are in the lowercased form the handler matches against
 *
 * The renderer side is checked by parsing SHORTCUT_ACTIONS out of the source
 * rather than importing it (it is deliberately not exported). Reading source is
 * the established idiom here -- the DOM fixture derives element ids the same way,
 * and docs-screensaver-list.test.js resolves the registry order from source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  SHORTCUTS,
  SHORTCUTS_BY_KEY,
  SHORTCUT_IDS,
  shortcutById,
  inputKeyFor,
} from '../src/renderer/shortcuts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = readFileSync(
  path.resolve(here, '../src/renderer/renderer.js'), 'utf8')
const INDEX_HTML = readFileSync(
  path.resolve(here, '../src/renderer/index.html'), 'utf8')
const CSS = readFileSync(
  path.resolve(here, '../src/renderer/styles.css'), 'utf8')

/** The declarations of a CSS rule, joined across every matching block. */
function ruleBody(selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  const bodies = [...CSS.matchAll(re)].map(m => m[1])
  expect(bodies.length, `rule not found: ${selector}`).toBeGreaterThan(0)
  return bodies.join('\n')
}

/** Ids SHORTCUT_ACTIONS defines, read from the renderer's source. */
function actionIds() {
  const start = RENDERER.indexOf('const SHORTCUT_ACTIONS = {')
  expect(start).toBeGreaterThan(-1)
  // The object ends at the first line that is a lone closing brace.
  const rest = RENDERER.slice(start)
  const end = rest.indexOf('\n}\n')
  expect(end).toBeGreaterThan(-1)
  const body = rest.slice(0, end)
  return [...body.matchAll(/^\s*'([a-z-]+)':/gm)].map(m => m[1])
}

describe('the list and the renderer agree', () => {
  it('gives every shortcut an action', () => {
    // The failure this catches: adding an entry to shortcuts.js, so it appears
    // in the Settings table and the dropdown, while the key does nothing.
    const missing = SHORTCUT_IDS.filter(id => !actionIds().includes(id))
    expect(missing).toEqual([])
  })

  it('gives every action a shortcut', () => {
    // And the reverse: an action whose key was dropped from the list is
    // unreachable, because the handler dispatches through SHORTCUTS_BY_KEY.
    const orphans = actionIds().filter(id => !SHORTCUT_IDS.includes(id))
    expect(orphans).toEqual([])
  })

  it('dispatches through the shared map, not a switch', () => {
    // Guards the mechanism itself. A switch on event.key would pass the two
    // tests above while making the list decorative.
    expect(RENDERER).toContain('SHORTCUTS_BY_KEY.get(event.key.toLowerCase())')
    const handler = RENDERER.slice(
      RENDERER.indexOf('function handleKeyDown(event) {'),
      RENDERER.indexOf('\n}\n', RENDERER.indexOf('function handleKeyDown(event) {')))
    expect(handler).not.toContain('case ')
  })
})

describe('key bindings', () => {
  it('binds no key twice', () => {
    // Enforced at module load, which is why importing the module at all is the
    // test. Restated here so the reason is visible.
    const all = SHORTCUTS.flatMap(s => s.keys)
    expect(new Set(all).size).toBe(all.length)
  })

  it('stores keys in the lowercase form the handler compares against', () => {
    // handleKeyDown looks up event.key.toLowerCase(), so an entry holding
    // 'Escape' or 'ArrowLeft' would never match.
    for (const shortcut of SHORTCUTS) {
      for (const key of shortcut.keys) {
        expect(key).toBe(key.toLowerCase())
      }
    }
  })

  it('covers the keys that were missing from the old table', () => {
    // The specific drift #258 was filed about.
    for (const key of ['q', 'v', '+', '-', 'f11']) {
      expect(SHORTCUTS_BY_KEY.has(key)).toBe(true)
    }
  })

  it('keeps the unshifted aliases that make stepping usable', () => {
    // '=' and '_' are what those keys produce without Shift on US/UK layouts.
    expect(SHORTCUTS_BY_KEY.get('=').id).toBe('screensaver-next')
    expect(SHORTCUTS_BY_KEY.get('_').id).toBe('screensaver-prev')
  })

  it('binds the space bar as a literal space', () => {
    expect(SHORTCUTS_BY_KEY.get(' ').id).toBe('freeze')
  })
})

describe('entry shape', () => {
  it('gives every entry the fields both consumers need', () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.id, `${shortcut.id} id`).toMatch(/^[a-z][a-z-]*$/)
      expect(shortcut.keys.length, `${shortcut.id} keys`).toBeGreaterThan(0)
      expect(shortcut.chips.length, `${shortcut.id} chips`).toBeGreaterThan(0)
      expect(typeof shortcut.label, `${shortcut.id} label`).toBe('string')
      expect(shortcut.label.length, `${shortcut.id} label`).toBeGreaterThan(0)
      expect(typeof shortcut.preventDefault, `${shortcut.id} preventDefault`)
        .toBe('boolean')
    }
  })

  it('preserves which shortcuts suppress the default action', () => {
    // Transcribed from the switch this replaced. Getting one of these wrong is
    // invisible in most cases and breaks a specific one: Space would scroll,
    // and F would type into a field that had focus.
    const expected = {
      'select-input': false, 'layout-dual': true, 'layout-single': true,
      'freeze': true, 'screensaver-toggle': true, 'screensaver-next': true,
      'screensaver-prev': true, 'fullscreen': true, 'escape': false,
      'quit': false, 'remote-back': false, 'remote-forward': false,
    }
    for (const [id, value] of Object.entries(expected)) {
      expect(shortcutById(id)?.preventDefault, id).toBe(value)
    }
  })
})

describe('inputKeyFor', () => {
  it('maps the first four rows to 1-4', () => {
    expect([0, 1, 2, 3].map(inputKeyFor)).toEqual(['1', '2', '3', '4'])
  })

  it('returns null past the fourth row', () => {
    // A wall can have more capture devices than there are number keys.
    // Labelling a fifth row '5' would promise a binding that does not exist.
    expect(inputKeyFor(4)).toBeNull()
    expect(inputKeyFor(11)).toBeNull()
  })
})

describe('the Settings table is no longer hand-maintained', () => {
  it('ships as an empty container for the renderer to fill', () => {
    expect(INDEX_HTML).toContain('id="shortcuts-table"')
  })

  it('has no hardcoded rows left to drift', () => {
    // The whole point of #258. A <tr> back in this file means someone started a
    // second list again.
    const start = INDEX_HTML.indexOf('id="shortcuts-table"')
    const table = INDEX_HTML.slice(start, INDEX_HTML.indexOf('</table>', start))
    expect(table).not.toContain('<tr>')
    expect(table).not.toContain('<kbd>')
  })
})

describe('the hints stay legible on the wall', () => {
  // Pinned because the first attempt got this wrong: 10px at opacity 0.55 looked
  // correct on a laptop and vanished on the 6000x1200 wall in a lit room. A hint
  // nobody can read fails at the only thing hints are for, so the floor is here
  // rather than in someone's memory.
  it('keeps the chip at or above 11px', () => {
    const size = ruleBody('.shortcut-hint kbd').match(/font-size:\s*(\d+)px/)
    expect(size, 'no font-size on .shortcut-hint kbd').not.toBeNull()
    expect(Number(size[1])).toBeGreaterThanOrEqual(11)
  })

  it('keeps the chip at or above 0.7 opacity', () => {
    const opacity = ruleBody('.shortcut-hint').match(/opacity:\s*([\d.]+)/)
    expect(opacity, 'no opacity on .shortcut-hint').not.toBeNull()
    expect(Number(opacity[1])).toBeGreaterThanOrEqual(0.7)
  })

  it('lifts the chip where it sits on the accent colour', () => {
    // A translucent white chip loses most of its contrast on the blue selected
    // row and the active view-mode button.
    expect(ruleBody('.view-mode-btn.active .shortcut-hint kbd'))
      .toMatch(/background-color/)
  })

  it('lets a long device name shrink so the chip stays in the row', () => {
    // min-width:0 is what actually permits this; the flex default of
    // min-width:auto holds the name at full width and pushes the chip out.
    expect(ruleBody('.input-option-name')).toMatch(/min-width:\s*0/)
  })
})
