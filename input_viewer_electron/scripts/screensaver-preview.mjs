#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Launches the screensaver preview harness (Vite dev server + browser).
 *
 *   npm run screensaver                    -> random screensaver + picker
 *   npm run screensaver -- 1               -> open screensaver index 1 (1-based)
 *   npm run screensaver -- plasma          -> open the "plasma" screensaver by name
 *   npm run screensaver -- plasma --wall   -> start in 6000x1200 videowall mode
 *
 * The selector is forwarded as the page URL hash, which preview.js reads;
 * --wall is forwarded as a ?wall query param. Wall mode is also toggleable
 * in-page with W, and ambient-light washout with L.
 */
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// `--wall` starts in 6000x1200 videowall emulation; anything else is the
// screensaver selector (index or name).
const args = process.argv.slice(2)
const wall = args.includes('--wall')
const pick = args.find((a) => !a.startsWith('--'))

const selector = pick ? `#${encodeURIComponent(pick)}` : ''
const query = wall ? '?wall' : ''

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
}

const server = await createServer({
  configFile: path.resolve(root, 'vite.preview.config.mjs'),
  // We open the browser ourselves so we can append the selector hash.
  server: { open: false }
})
await server.listen()

const { port } = server.config.server
const base = `http://localhost:${port}/preview.html${query}${selector}`
server.printUrls()
console.log(`\n  Screensaver preview: ${base}`)
if (wall) console.log('  Videowall emulation: 6000x1200, scaled to fit')
console.log('  Keys in window: ←/→ cycle · R restart · H hide HUD · F fullscreen')
console.log('                  W videowall 6000x1200 · L washout (ambient light)')
console.log('  Press Ctrl+C to stop.\n')
openBrowser(base)
