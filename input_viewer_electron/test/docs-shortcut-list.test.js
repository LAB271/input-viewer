// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The shortcut tables in README.md and docs/USER_GUIDE.md (#258).
 *
 * #258 was filed about two lists disagreeing -- the keydown handler and the
 * Settings table. Unifying those turned up two more: both markdown tables, each
 * drifted in its own direction. README was missing the remote-keyboard row,
 * USER_GUIDE was missing F11.
 *
 * The tables stay hand-written, because they carry prose the app's own UI does
 * not. What they cannot do any more is silently omit a key: this asserts every
 * chip in SHORTCUTS appears in both. Same idea as docs-screensaver-list.test.js,
 * which pins the guide's screensaver list to the registry.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SHORTCUTS } from '../src/renderer/shortcuts.js'
import { projectRoot } from './helpers/renderer-dom.js'

const REPO = path.resolve(projectRoot, '..')

/**
 * The TABLE ROWS of a markdown file's Keyboard Shortcuts section.
 *
 * Rows only, not the whole section. Both files follow their table with prose
 * that mentions keys in backticks -- README explains `V` and `+`/`-` in a
 * paragraph underneath -- and searching the section as a whole let a deleted
 * table row pass because the prose still named the key. Verified by deleting
 * README's V row: the looser version stayed green.
 */
function shortcutSection(relPath) {
  const text = readFileSync(path.join(REPO, relPath), 'utf8')
  const start = text.indexOf('## Keyboard Shortcuts')
  expect(start, `no shortcut section in ${relPath}`).toBeGreaterThan(-1)
  const after = text.indexOf('\n## ', start + 1)
  const section = text.slice(start, after === -1 ? undefined : after)
  const rows = section.split('\n').filter(line => line.trimStart().startsWith('|'))
  expect(rows.length, `no table rows in ${relPath}`).toBeGreaterThan(1)
  return rows.join('\n')
}

const DOCS = ['README.md', 'docs/USER_GUIDE.md']

/**
 * Printings a chip may legitimately take in prose.
 *
 * Tolerance for formatting, not for omission -- a chip with no entry here must
 * appear exactly as the UI prints it. Kept deliberately short: every addition
 * here is a way for the docs and the app to disagree while this still passes.
 */
const DOC_SPELLINGS = {
  // The range is printed as one token rather than as two ends.
  '1': ['1', '1-4'],
  '4': ['4', '1-4'],
  // Both are ordinary names for the key.
  'Esc': ['Esc', 'Escape'],
}

describe.each(DOCS)('%s lists every shortcut', (relPath) => {
  const section = shortcutSection(relPath)

  it.each(SHORTCUTS.map(s => [s.id, s.chips]))(
    'documents %s', (_id, chips) => {
      for (const chip of chips) {
        const accepted = DOC_SPELLINGS[chip] ?? [chip]
        // Backticked, which is how every row in both tables prints a key.
        const found = accepted.some(spelling => section.includes(`\`${spelling}\``))
        expect(found, `missing \`${chip}\` (accepted: ${accepted.join(', ')})`)
          .toBe(true)
      }
    })
})

describe('the docs claim no keys that do not exist', () => {
  it.each(DOCS)('%s', (relPath) => {
    const section = shortcutSection(relPath)
    // Every backticked single token in the section that looks like a key.
    const claimed = [...section.matchAll(/`([^`]+)`/g)].map(m => m[1])
    const known = new Set(SHORTCUTS.flatMap(s => s.chips))
    // Aliases the docs may print that the chips deliberately omit: the chips
    // show one representative per binding, the prose may show more.
    const allowed = new Set([...known, '=', '_', 'Escape', '1-4', 'PgDn', 'PgUp'])
    const unknown = claimed.filter(c => c.length <= 6 && !allowed.has(c))
    expect(unknown).toEqual([])
  })
})
