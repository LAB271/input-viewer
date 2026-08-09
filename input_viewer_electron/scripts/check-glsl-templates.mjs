#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Catch backticks inside GLSL template literals (issue #155).
 *
 * Shaders live in JS template literals marked `/* glsl *\/`. A backtick
 * anywhere inside one -- including in a GLSL comment -- ends the string, and
 * the JS syntax error that follows points at a line that looks fine.
 *
 * This broke the build four times in one session, always the same way: writing
 * a shader comment like
 *
 *     // Named columnLive, not `active`, which is reserved
 *
 * ESLint already fails on such a file, so detection was never the gap. The gap
 * is DIAGNOSIS: it reports `Parsing error: Unexpected token active`, which does
 * not mention backticks, templates or shaders, and points at the shader body
 * rather than at the cause. An ESLint rule cannot improve on that, because a
 * rule only runs on files that parse -- and by definition these do not.
 *
 * So this is a text scan rather than an AST rule: it works precisely when the
 * file is unparseable, which is the only case that matters.
 *
 * Usage: npm run lint (runs this first), or node scripts/check-glsl-templates.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', 'src')

/** Every .js file under src/, recursively. */
function jsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...jsFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * Find GLSL templates that end inside a `//` comment.
 *
 * A template ending mid-comment is the signature: the backtick that closed it
 * was meant as punctuation, not as a delimiter.
 */
function findBadTemplates(source) {
  const opener = /\/\*\s*glsl\s*\*\/\s*`/g
  const problems = []
  let match

  while ((match = opener.exec(source))) {
    const bodyStart = match.index + match[0].length
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue }
      if (source[i] !== '`') continue

      // Found where this template ends. If the last line of its body has an
      // unterminated `//` comment, the template ended inside that comment.
      const body = source.slice(bodyStart, i)
      const lastLine = body.slice(body.lastIndexOf('\n') + 1)
      if (/\/\//.test(lastLine)) {
        problems.push({
          line: source.slice(0, i).split('\n').length,
          text: lastLine.trim()
        })
      }
      break
    }
  }
  return problems
}

let failed = false
for (const file of jsFiles(ROOT)) {
  const rel = path.relative(path.resolve(import.meta.dirname, '..'), file)
  for (const p of findBadTemplates(readFileSync(file, 'utf8'))) {
    failed = true
    console.error(`${rel}:${p.line}  Backtick inside a GLSL comment ends the shader template.`)
    console.error(`  ${p.text}\``)
    console.error('  GLSL has no template literals -- write the identifier unquoted.\n')
  }
}

if (failed) {
  console.error('GLSL template check failed.')
  process.exit(1)
}
