#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Render a vitest JUnit report as a GitHub Actions job summary (markdown on
 * stdout).
 *
 *   node scripts/test-summary.mjs junit.xml >> "$GITHUB_STEP_SUMMARY"
 *
 * Deliberately dependency-free and failure-tolerant: it runs with `if: always()`
 * so it must never turn a passing run red, nor mask a real failure. If the
 * report is missing or unparseable it says so and exits 0 -- the test step's own
 * exit code is what decides the run.
 *
 * Regex parsing rather than an XML library is fine here: the input is vitest's
 * own generated output, not arbitrary XML.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'junit.xml'

function attr(tag, name) {
  // The leading boundary matters: without it, `name` also matches the tail of
  // `classname="..."` and both attributes read back the same value.
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return m ? m[1] : ''
}

// JUnit escapes these in attribute values; undo them for display.
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function num(tag, name) {
  const v = Number.parseInt(attr(tag, name), 10)
  return Number.isFinite(v) ? v : 0
}

let xml
try {
  xml = readFileSync(file, 'utf8')
} catch {
  // No report: the run almost certainly died before tests executed (a worker
  // that failed to boot, an install problem). Say so rather than implying zero
  // failures.
  console.log('### Test results')
  console.log()
  console.log(`No JUnit report at \`${file}\` — the test run likely failed before any test executed.`)
  console.log('Check the "Unit tests" step output.')
  process.exit(0)
}

const rootTag = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? ''
const suiteTags = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map(m => m[0])

const total = num(rootTag, 'tests')
const failures = num(rootTag, 'failures')
const errors = num(rootTag, 'errors')
const passed = total - failures - errors
const ok = failures === 0 && errors === 0

console.log('### Test results')
console.log()
console.log(`${ok ? '✅' : '❌'} **${passed}/${total} passed**` +
  (failures ? ` · ${failures} failed` : '') +
  (errors ? ` · ${errors} errors` : '') +
  ` · ${suiteTags.length} files`)
console.log()

if (suiteTags.length) {
  console.log('| File | Tests | Failed | Skipped |')
  console.log('| --- | --- | --- | --- |')
  for (const tag of suiteTags) {
    const f = num(tag, 'failures') + num(tag, 'errors')
    console.log(`| \`${unescapeXml(attr(tag, 'name'))}\` | ${num(tag, 'tests')} | ${f || '—'} | ${num(tag, 'skipped') || '—'} |`)
  }
  console.log()
}

// Name the failures so the summary is actionable without opening the log.
const failed = [...xml.matchAll(/<testcase\b([^>]*)>(?:(?!<\/testcase>)[\s\S])*?<(?:failure|error)\b/g)]
  .map(m => `\`${attr(m[1], 'classname')}\` › ${unescapeXml(attr(m[1], 'name'))}`)

if (failed.length) {
  console.log('<details><summary>Failed tests</summary>')
  console.log()
  for (const name of failed) console.log(`- ${name}`)
  console.log()
  console.log('</details>')
}
