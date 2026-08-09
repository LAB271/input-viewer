// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Compile every screensaver's shaders on a real GPU, headlessly.
 *
 * Starts the preview Vite server, points headless Chrome at shadercheck.html,
 * and exits non-zero if any shader failed to compile or link.
 *
 * Why this is a separate script rather than a vitest suite: there is no WebGL2
 * context in the node test environment, and headless-gl would mean a native
 * build dependency on every machine that runs `npm ci`. The static GLSL checks
 * in test/screensaver-seed.test.js cover what can be checked without a driver
 * (malformed literals, unbalanced braces, iSeed swizzles); this covers the rest.
 *
 * Usage: npm run shadercheck
 */
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// Headless Chrome needs SwiftShader to get a WebGL2 context without a display.
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

const chrome = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('shader-check: no Chrome/Chromium found. Set CHROME_PATH.')
  process.exit(2)
}

const server = await createServer({
  configFile: 'vite.preview.config.mjs',
  server: { open: false }
})
await server.listen()
const port = server.config.server.port
const url = `http://localhost:${port}/shadercheck.html`

const args = [
  '--headless=new',
  '--disable-gpu-sandbox',
  // SwiftShader so this works on a headless box with no GPU. It still enforces
  // the full GLSL ES 3.00 spec, which is the point. On a machine with a real
  // GPU Chrome may ignore this and use it -- also fine, and stricter.
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--enable-logging=stderr',
  '--v=0',
  // The harness reports through console.log, which lands in stderr with
  // --enable-logging. requestAnimationFrame does not advance under
  // --virtual-time-budget in headless-new, so give it real wall-clock time and
  // enforce the ceiling from this side instead.
  url
]

const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] })
let combined = ''
let settled = false

/** Resolve as soon as the harness reports, rather than waiting for exit. */
const done = await new Promise((resolve) => {
  const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
  const onData = (d) => {
    combined += d
    const m = combined.match(/SHADERCHECK_DONE ok=(\d+) fail=(-?\d+)/)
    if (m) finish(m)
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  proc.on('close', () => finish(combined.match(/SHADERCHECK_DONE ok=(\d+) fail=(-?\d+)/)))
  // Ceiling: 12 savers x 5 seeds x 5 frames is a couple of seconds of real work,
  // but a hung shader compile would otherwise block forever.
  setTimeout(() => finish(null), 900000)
})

proc.kill()
await server.close()

// The harness echoes its own log through console.log, which Chrome prefixes
// with INFO:CONSOLE. Pull those lines out; they are the useful output.
const consoleLines = combined
  .split('\n')
  .map((l) => {
    const m = l.match(/INFO:CONSOLE\(\d+\)] "([\s\S]*)"(?:, source:.*)?$/) || l.match(/INFO:CONSOLE:\d+] "([\s\S]*?)", source:/)
    return m ? m[1] : null
  })
  .filter((l) => l && !/GL Driver Message|GPU stall/.test(l))
if (consoleLines.length) console.log(consoleLines.join('\n'))

if (!done) {
  console.error('shader-check: harness did not report within the timeout.')
  const hint = combined.split('\n').filter((l) => /webgl2|Shader compile|link error|Error/i.test(l)).slice(0, 10)
  if (hint.length) console.error(hint.join('\n'))
  process.exit(2)
}

const fail = Number(done[2])
if (fail !== 0) {
  console.error(`shader-check: ${fail} run(s) failed.`)
  process.exit(1)
}
console.log(`shader-check: all ${done[1]} runs compiled cleanly.`)
