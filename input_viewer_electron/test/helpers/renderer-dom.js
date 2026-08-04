// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * DOM fixture for the renderer tests.
 *
 * renderer.js builds its `elements` map at module load via getElementById, so
 * the document has to be populated *before* the module is imported. It also
 * calls init() at module scope; __INPUT_VIEWER_NO_AUTOSTART__ suppresses that
 * so importing does not boot device enumeration, streams or screensavers.
 *
 * The element ids are derived from renderer.js itself rather than hand-listed,
 * so this fixture cannot silently drift out of date when the renderer starts
 * using a new node -- a missing id would otherwise surface as a confusing
 * "cannot read properties of null" deep inside a state function.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_PATH = path.resolve(here, '../../src/renderer/renderer.js')

/**
 * Absolute path to input_viewer_electron/. Exported because under the jsdom
 * environment `import.meta.url` is not a file: URL, so tests cannot resolve
 * source paths relative to themselves.
 */
export const projectRoot = path.resolve(here, '../..')

/** Element ids renderer.js looks up, read straight from its source. */
export function requiredElementIds() {
  const src = readFileSync(RENDERER_PATH, 'utf8')
  const ids = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1])
  return [...new Set(ids)]
}

// Nodes the renderer reaches for with a descendant selector rather than an id.
// These mirror src/renderer/index.html, where each feed contains both a label
// and a no-signal overlay.
const NESTED = [
  { parent: 'left-feed', className: 'input-label' },
  { parent: 'right-feed', className: 'input-label' },
  { parent: 'left-feed', className: 'no-signal-overlay hidden' },
  { parent: 'right-feed', className: 'no-signal-overlay hidden' },
]

/**
 * jsdom ships no canvas backend, so getContext() returns null and any drawing
 * path (freeze-frame capture, detection) throws on a null context. Stub a
 * chainable 2D context: these tests assert state transitions, not pixels.
 */
function stubCanvas2D() {
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
    fillRect() {}, clearRect() {}, strokeRect() {}, drawImage() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
    fill() {}, stroke() {}, save() {}, restore() {}, translate() {},
    rotate() {}, scale() {}, setTransform() {}, fillText() {},
    measureText: () => ({ width: 0 }),
    getImageData: (x, y, w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
    }),
    putImageData() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  }
  globalThis.HTMLCanvasElement.prototype.getContext = function (type) {
    return type === '2d' ? ctx : null
  }
  globalThis.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,'
}

/**
 * Populate document.body with everything renderer.js needs, then flag the
 * module not to autostart. Call before importing renderer.js.
 */
export function installRendererDom() {
  const parts = requiredElementIds().map(id => {
    // A canvas needs to be a real canvas: freeze/screensaver paths call
    // getContext on these.
    if (id.endsWith('canvas')) return `<canvas id="${id}"></canvas>`
    if (id.endsWith('-toggle')) return `<input type="checkbox" id="${id}">`
    // Range inputs back the gap/border sliders.
    if (id === 'settings-center-gap' || id === 'settings-border-width') {
      return `<input type="range" id="${id}" min="0" max="200" value="0">`
    }
    if (id.endsWith('-host') || id.endsWith('-api-key')) {
      return `<input type="text" id="${id}">`
    }
    return `<div id="${id}"></div>`
  })

  document.body.innerHTML = parts.join('\n')

  for (const { parent, className } of NESTED) {
    const el = document.getElementById(parent)
    const child = document.createElement('div')
    child.className = className
    el.appendChild(child)
  }

  stubCanvas2D()
  globalThis.__INPUT_VIEWER_NO_AUTOSTART__ = true
}

/**
 * Minimal stand-in for a capture device as returned by enumerateDevices.
 */
export function device(deviceId, label = deviceId) {
  return { deviceId, label, kind: 'videoinput' }
}
