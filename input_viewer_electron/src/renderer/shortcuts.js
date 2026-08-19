// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The keyboard shortcuts, as data (#258).
 *
 * One list, three consumers: the keydown handler builds its lookup from it, the
 * dropdown labels its controls from it, and the Settings panel renders its table
 * from it. Before this there were two hand-maintained lists -- the switch in
 * renderer.js and a hardcoded <table> in index.html -- and the table had already
 * drifted: it was missing Q, V, +/- and F11, so the one place documenting the
 * keys omitted four of them.
 *
 * That is the whole argument for this module. Two lists means two places to
 * drift, and the drift is silent: nothing failed, the table was just quietly
 * wrong for however long it took someone to notice.
 *
 * This file holds no actions and imports nothing. The renderer supplies a
 * function per `id`, which keeps the data testable without a DOM and avoids the
 * circular import that binding actions here would need.
 *
 * `keys` are matched against `event.key.toLowerCase()`, so every entry must be
 * lowercase. 'Escape' arrives as 'escape', 'ArrowLeft' as 'arrowleft', the space
 * bar as ' '.
 */

/**
 * @typedef {object} Shortcut
 * @property {string} id           looked up by the renderer to find its action
 * @property {string[]} keys       event.key values, lowercased
 * @property {string[]} chips      keys as the UI should print them
 * @property {string} [chipSep]    printed between chips; defaults to ' / '
 * @property {string} label        what the shortcut does
 * @property {string} [note]       caveat shown after the label
 * @property {boolean} preventDefault
 */

/** @type {Shortcut[]} */
export const SHORTCUTS = [
  {
    id: 'select-input',
    keys: ['1', '2', '3', '4'],
    chips: ['1', '4'],
    // An en dash, not a slash: these are a range, and four separate chips would
    // be both wider and less clear.
    chipSep: '–',
    label: 'Select input',
    preventDefault: false,
  },
  {
    id: 'layout-dual',
    keys: ['d'],
    chips: ['D'],
    label: 'Dual view',
    preventDefault: true,
  },
  {
    id: 'layout-single',
    keys: ['s'],
    chips: ['S'],
    label: 'Single view',
    preventDefault: true,
  },
  {
    id: 'freeze',
    keys: [' '],
    chips: ['Space'],
    label: 'Freeze frame',
    preventDefault: true,
  },
  {
    id: 'screensaver-toggle',
    keys: ['v'],
    chips: ['V'],
    label: 'Screensaver on demand',
    preventDefault: true,
  },
  {
    id: 'screensaver-next',
    keys: ['+', '='],
    // '=' is the unshifted key that produces '+' on US/UK layouts, so both are
    // bound; only '+' is worth printing.
    chips: ['+'],
    label: 'Next screensaver',
    preventDefault: true,
  },
  {
    id: 'screensaver-prev',
    keys: ['-', '_'],
    chips: ['-'],
    label: 'Previous screensaver',
    preventDefault: true,
  },
  {
    id: 'fullscreen',
    keys: ['f', 'f11'],
    chips: ['F', 'F11'],
    label: 'Fullscreen',
    preventDefault: true,
  },
  {
    id: 'escape',
    keys: ['escape'],
    chips: ['Esc'],
    label: 'Exit fullscreen, unfreeze, close panels',
    preventDefault: false,
  },
  {
    id: 'quit',
    keys: ['q'],
    chips: ['Q'],
    label: 'Quit',
    preventDefault: false,
  },
  {
    id: 'remote-back',
    keys: ['pageup', 'arrowleft'],
    chips: ['←', 'PgUp'],
    label: 'Presentation: back',
    note: 'if the remote keyboard is enabled',
    preventDefault: false,
  },
  {
    id: 'remote-forward',
    keys: ['pagedown', 'arrowright'],
    chips: ['→', 'PgDn'],
    label: 'Presentation: forward',
    note: 'if the remote keyboard is enabled',
    preventDefault: false,
  },
]

/**
 * Map of event.key -> shortcut, built once.
 *
 * Also the duplicate-binding check: two entries claiming the same key would
 * silently shadow each other in the handler, so that throws at module load
 * rather than becoming a key that does the wrong thing.
 */
export const SHORTCUTS_BY_KEY = (() => {
  const map = new Map()
  for (const shortcut of SHORTCUTS) {
    for (const key of shortcut.keys) {
      if (map.has(key)) {
        throw new Error(
          `shortcut key "${key}" is claimed by both ` +
          `"${map.get(key).id}" and "${shortcut.id}"`)
      }
      map.set(key, shortcut)
    }
  }
  return map
})()

/** Every id in the list, for cross-checking against the renderer's actions. */
export const SHORTCUT_IDS = SHORTCUTS.map(s => s.id)

/** Look up a shortcut by id, or undefined. */
export function shortcutById(id) {
  return SHORTCUTS.find(s => s.id === id)
}

/**
 * The key that selects the input at `index` in the dropdown, or null.
 *
 * Returns null past the fourth input rather than inventing a key: the wall can
 * have more capture devices than there are number keys, and labelling a fifth
 * row '5' would promise a binding that does not exist.
 */
export function inputKeyFor(index) {
  const shortcut = shortcutById('select-input')
  return shortcut?.keys[index] ?? null
}
