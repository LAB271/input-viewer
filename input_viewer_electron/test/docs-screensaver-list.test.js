// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The screensaver list in the user guide must match the registry (#206).
 *
 * That issue notes the list "will go stale the moment a saver is added -- it
 * already has, twice", and suggests generating it. A test is the cheaper half of
 * that: it needs nobody to remember to run a script, and it fails in CI the moment
 * prose and code disagree.
 *
 * registry.js cannot be imported here -- it reaches for document at module scope
 * and there is no WebGL2 in the node environment -- so the order is recovered from
 * source the same way screensaver-aspect.test.js handles GLSL.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SAVERS = path.join(import.meta.dirname, '..', 'src', 'renderer', 'screensavers')
const GUIDE = path.join(import.meta.dirname, '..', '..', 'docs', 'USER_GUIDE.md')
const README = path.join(import.meta.dirname, '..', '..', 'README.md')

/** Display names in rotation order, resolved from registry.js and each module. */
function registryOrder () {
  const reg = readFileSync(path.join(SAVERS, 'registry.js'), 'utf8')
  const imports = new Map(
    [...reg.matchAll(/^import\s+(\w+)\s+from\s+'\.\/([\w.-]+)'/gm)].map(m => [m[1], m[2]]))
  const block = /export const SCREENSAVERS = \[([\s\S]*?)\]/.exec(reg)
  expect(block, 'SCREENSAVERS array not found').toBeTruthy()
  const ids = block[1].split('\n').map(l => l.trim().replace(/,$/, '')).filter(Boolean)
  return ids.map((id) => {
    const file = imports.get(id)
    expect(file, `no import for ${id}`).toBeTruthy()
    const src = readFileSync(path.join(SAVERS, file), 'utf8')
    // Two registration styles: createShaderScreensaver('Name', ...) for the pure
    // fragment savers, and a name: field for the ones that drive their own loop.
    const m = /createShaderScreensaver\(\s*'([^']+)'/.exec(src) ||
              /^\s*name:\s*'([^']+)'/m.exec(src)
    expect(m, `no display name in ${file}`).toBeTruthy()
    return m[1]
  })
}

/** The numbered list between the marker comments in the user guide. */
function documentedOrder () {
  const guide = readFileSync(GUIDE, 'utf8')
  const block = /<!-- SCREENSAVER-LIST -->([\s\S]*?)<!-- \/SCREENSAVER-LIST -->/.exec(guide)
  expect(block, 'SCREENSAVER-LIST markers not found in the user guide').toBeTruthy()
  return [...block[1].matchAll(/^\d+\.\s+(.+?)\s*$/gm)].map(m => m[1])
}

describe('the documented screensaver list', () => {
  it('matches the registry exactly, in rotation order', () => {
    // Order matters as well as membership: the guide states this is the order the
    // + and - keys step through, so a reordered registry makes the prose wrong
    // even when every name is still present.
    expect(documentedOrder()).toEqual(registryOrder())
  })

  it('says how many there are, and is right', () => {
    const n = registryOrder().length
    const guide = readFileSync(GUIDE, 'utf8')
    const readme = readFileSync(README, 'utf8')
    expect(guide, `user guide should state ${n}`).toContain(`**${n}**`)
    expect(readme, `README should state ${n}`).toContain(`${n} screensavers`)
  })

  it('no longer calls the screensaver a bouncing logo', () => {
    // The defect #206 was filed for. Checked in both documents, because the same
    // line appeared in each.
    for (const [name, file] of [['user guide', GUIDE], ['README', README]]) {
      expect(readFileSync(file, 'utf8').toLowerCase(), `${name} still says it`)
        .not.toContain('bouncing logo')
    }
  })

  it('documents the production screensaver keys', () => {
    const guide = readFileSync(GUIDE, 'utf8')
    // V, + and - were absent entirely, which is how the omission was noticed.
    expect(guide).toMatch(/\|\s*`V`\s*\|/)
    expect(guide).toMatch(/`\+`\s*\/\s*`-`/)
  })

  it('explains that the split-flap board is not in the rotation', () => {
    expect(readFileSync(GUIDE, 'utf8')).toMatch(/split-flap/i)
    expect(registryOrder()).not.toContain('Split Flap')
  })
})
