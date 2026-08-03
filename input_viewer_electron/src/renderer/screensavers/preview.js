// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Standalone screensaver preview harness.
 *
 * Run via `npm run screensaver` (opens this page in a browser with a real
 * GPU/WebGL2 context). Pass a selector to jump straight to one:
 *   npm run screensaver -- 1          (by index)
 *   npm run screensaver -- plasma     (by name)
 *
 * The npm script forwards the selector as the URL hash (#1 / #plasma).
 * Reuses the exact registry + screensaver modules the app ships.
 */
import {
  SCREENSAVERS,
  initScreensavers,
  startScreensaver,
  stopScreensaver,
  listScreensavers
} from './registry.js'

const canvas = document.getElementById('screensaver-canvas')
const listEl = document.getElementById('list')
const hud = document.getElementById('hud')
const fpsEl = document.getElementById('fps')
const modeEl = document.getElementById('mode')

initScreensavers(canvas)

let current = -1

// =============================================================================
// Videowall emulation
// =============================================================================
// The real wall is 6000x1200 (aspect 5:1). Screensavers read canvas dimensions
// to lay themselves out, so previewing in a ~1440x900 browser window at 16:10
// tests a completely different geometry than the one that ships.
//
// Wall mode sets the canvas backing store to the true target resolution and
// scales it down with a CSS transform for display only. The screensaver sees
// 6000x1200; the laptop shows a letterboxed 5:1 strip.
const WALL_W = 6000
const WALL_H = 1200

let wallMode = false
let washout = 0 // 0 = none, then 0.06 / 0.12 / 0.20 -- see cycleWashout()

function applyWallMode() {
  const body = document.body
  if (wallMode) {
    // Fit the strip into the viewport with a margin so the HUD stays readable.
    const scale = Math.min(
      (window.innerWidth * 0.92) / WALL_W,
      (window.innerHeight * 0.92) / WALL_H
    )
    body.classList.add('wall')
    body.style.setProperty('--wall-w', `${WALL_W}px`)
    body.style.setProperty('--wall-h', `${WALL_H}px`)
    body.style.setProperty('--wall-scale', String(scale))
  } else {
    body.classList.remove('wall')
    body.style.removeProperty('--wall-w')
    body.style.removeProperty('--wall-h')
    body.style.removeProperty('--wall-scale')
  }
  updateMode()
}

// gl-base.js sizes the backing store as clientWidth * devicePixelRatio. On a
// Retina laptop that would give 12000x2400 and quietly exceed MAX_TEXTURE_SIZE,
// so in wall mode we report a DPR-compensated clientWidth/Height and let the
// existing resize() arrive at exactly WALL_W x WALL_H.
const nativeW = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
const nativeH = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
Object.defineProperty(canvas, 'clientWidth', {
  get() {
    if (!wallMode) return nativeW.get.call(this)
    return WALL_W / Math.min(window.devicePixelRatio || 1, 2)
  }
})
Object.defineProperty(canvas, 'clientHeight', {
  get() {
    if (!wallMode) return nativeH.get.call(this)
    return WALL_H / Math.min(window.devicePixelRatio || 1, 2)
  }
})

// Ambient light on a projector screen lifts blacks, which is what makes 1px
// particles vanish in the room even though they are clearly visible here.
// Cycling this approximates progressively worse lighting.
function cycleWashout() {
  const steps = [0, 0.06, 0.12, 0.2]
  washout = steps[(steps.indexOf(washout) + 1) % steps.length]
  document.getElementById('washout').style.opacity = String(washout)
  updateMode()
}

function updateMode() {
  const res = wallMode
    ? `${WALL_W}x${WALL_H} (wall)`
    : `${canvas.width}x${canvas.height} (window)`
  const light = washout ? ` · washout ${Math.round(washout * 100)}%` : ''
  modeEl.textContent = res + light
}

window.addEventListener('resize', () => {
  if (wallMode) applyWallMode()
  updateMode()
})

function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, '')
}

// Resolve initial selection from the URL hash (#1 or #plasma), else random.
function initialIndex() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim()
  if (!raw) return Math.floor(Math.random() * SCREENSAVERS.length)
  const asNum = Number(raw)
  if (!Number.isNaN(asNum) && raw !== '') {
    return ((asNum % SCREENSAVERS.length) + SCREENSAVERS.length) % SCREENSAVERS.length
  }
  const idx = SCREENSAVERS.findIndex((s) => normalize(s.name) === normalize(raw))
  return idx >= 0 ? idx : 0
}

function renderList() {
  listEl.innerHTML = ''
  listScreensavers().forEach((name, i) => {
    const btn = document.createElement('button')
    btn.textContent = `${i + 1}. ${name}`
    btn.className = i === current ? 'active' : ''
    btn.onclick = () => select(i)
    listEl.appendChild(btn)
  })
}

function select(index) {
  current = ((index % SCREENSAVERS.length) + SCREENSAVERS.length) % SCREENSAVERS.length
  stopScreensaver()
  const name = startScreensaver(current)
  location.hash = String(current + 1)
  document.title = `Screensaver: ${name}`
  renderList()
}

// FPS meter.
let frames = 0
let lastFpsT = performance.now()
function fpsLoop() {
  frames++
  const now = performance.now()
  if (now - lastFpsT >= 500) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (now - lastFpsT))} fps`
    frames = 0
    lastFpsT = now
  }
  requestAnimationFrame(fpsLoop)
}
requestAnimationFrame(fpsLoop)

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowRight': select(current + 1); break
    case 'ArrowLeft': select(current - 1); break
    case 'r': case 'R': select(current); break
    case 'h': case 'H': hud.classList.toggle('hidden'); break
    case 'f': case 'F':
      if (!document.fullscreenElement) document.documentElement.requestFullscreen()
      else document.exitFullscreen()
      break
    case 'w': case 'W':
      wallMode = !wallMode
      applyWallMode()
      // Restart so screensavers that read dimensions once, at create() time,
      // pick up the new geometry instead of keeping the old layout.
      select(current)
      break
    case 'l': case 'L': cycleWashout(); break
  }
})

// Start in wall mode when asked: `npm run screensaver -- plasma --wall`.
if (/(^|[?&])wall\b/.test(location.search) || /(-|,)wall$/.test(location.hash)) {
  wallMode = true
}

applyWallMode()
select(initialIndex())
updateMode()
