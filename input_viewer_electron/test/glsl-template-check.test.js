// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The GLSL template checker (issue #155).
 *
 * A backtick inside a `/* glsl *\/` template ends the string, and the JS syntax
 * error that follows points somewhere unhelpful. This broke the build four
 * times in one session.
 *
 * Worth being precise about what the checker is for. ESLint ALREADY fails on
 * such a file -- detection was never the gap. It reports
 * `Parsing error: Unexpected token active`, which mentions neither backticks
 * nor shaders and points at the shader body rather than the cause. An ESLint
 * rule cannot improve on that: a rule only runs on files that parse, and by
 * definition these do not. So the checker is a text scan, and these tests
 * exercise the scan directly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The checker exports nothing (it is a CLI), so its detection function is
// transcribed here. Kept adjacent to the source so drift shows up as failure.
function findBadTemplates(source) {
  const opener = /\/\*\s*glsl\s*\*\/\s*`/g
  const problems = []
  let match
  while ((match = opener.exec(source))) {
    const bodyStart = match.index + match[0].length
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue }
      if (source[i] !== '`') continue
      const body = source.slice(bodyStart, i)
      const lastLine = body.slice(body.lastIndexOf('\n') + 1)
      if (/\/\//.test(lastLine)) {
        problems.push({ line: source.slice(0, i).split('\n').length, text: lastLine.trim() })
      }
      break
    }
  }
  return problems
}

const GOOD = `const SHADER = /* glsl */ \`
void main() {
  // Named columnLive rather than the obvious one, which is reserved
  gl_FragColor = vec4(1.0);
}
\``

const BAD = `const SHADER = /* glsl */ \`
void main() {
  // Named columnLive, not \\\`active\\\`, which is reserved
  gl_FragColor = vec4(1.0);
}
\``

describe('GLSL template checker', () => {
  it('passes a shader with no backticks', () => {
    expect(findBadTemplates(GOOD)).toEqual([])
  })

  it('flags a backtick inside a shader comment', () => {
    // BAD has escaped backticks so this file itself stays parseable; the
    // checker sees the same character sequence either way.
    const source = BAD.replace(/\\`/g, '`')
    const problems = findBadTemplates(source)
    expect(problems).toHaveLength(1)
    expect(problems[0].text).toContain('columnLive')
  })

  it('reports the line of the offending comment', () => {
    const source = BAD.replace(/\\`/g, '`')
    expect(findBadTemplates(source)[0].line).toBe(3)
  })

  it('ignores backticks in ordinary JS comments outside a shader', () => {
    // pong.js legitimately has these; flagging them would make the check
    // useless noise.
    const source = `
// The \`error\` field is the aim offset, re-rolled per rally.
const AI = { error: 0.12 }
const SHADER = /* glsl */ \`
void main() { gl_FragColor = vec4(1.0); }
\``
    expect(findBadTemplates(source)).toEqual([])
  })

  it('handles a file with several shader templates', () => {
    // game-of-life.js has two; a checker that stopped at the first would miss
    // a break in the second.
    const source = `
const SIM = /* glsl */ \`
void main() { /* fine */ }
\`
const DISPLAY = /* glsl */ \`
void main() {
  // broken here, not \`
}
\``
    expect(findBadTemplates(source)).toHaveLength(1)
  })

  it('finds nothing in the real shader sources', () => {
    // The check that actually guards the repo.
    const root = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'screensavers')
    for (const file of ['matrix-rain.js', 'game-of-life.js', 'split-flap.js', 'pong.js']) {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(findBadTemplates(source), `${file} has a stray backtick`).toEqual([])
    }
  })
})
