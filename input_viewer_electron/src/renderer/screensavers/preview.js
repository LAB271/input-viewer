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
import { getActivePostChain } from './post-fx.js'
// The no-signal board is not a registry entry -- it is the no-signal display
// rather than a rotating screensaver (#92) -- but it still needs reviewing at
// wall aspect and under washout, so the preview appends it to the list and
// drives it directly.
import splitFlap from './split-flap.js'

const EXTRAS = [splitFlap]

// Total selectable entries: the shipped rotation plus the preview-only extras.
const TOTAL_ENTRIES = SCREENSAVERS.length + EXTRAS.length

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

let bloomOverride = null

function adjustBloom(key, delta) {
  const chain = getActivePostChain()
  if (!chain) { modeEl.textContent = 'no post chain on this screensaver'; return }
  const p = chain.params
  if (bloomOverride === null) bloomOverride = { ...p }
  p[key] = Math.max(0, +(p[key] + delta).toFixed(3))
  updateMode()
}

function resetBloom() {
  const chain = getActivePostChain()
  if (!chain || bloomOverride === null) return
  Object.assign(chain.params, bloomOverride)
  bloomOverride = null
  updateMode()
}

function bloomLabel() {
  const chain = getActivePostChain()
  if (!chain) return ''
  const p = chain.params
  return ` · bloom thr ${p.threshold.toFixed(2)} int ${p.intensity.toFixed(2)}`
}

function updateMode() {
  const res = wallMode
    ? `${WALL_W}x${WALL_H} (wall)`
    : `${canvas.width}x${canvas.height} (window)`
  const light = washout ? ` · washout ${Math.round(washout * 100)}%` : ''
  modeEl.textContent = res + light + bloomLabel()
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
  if (!raw) return Math.floor(Math.random() * TOTAL_ENTRIES)
  const asNum = Number(raw)
  if (!Number.isNaN(asNum) && raw !== '') {
    // The hash is 1-based (select() writes current + 1, and the list is
    // numbered from 1), so convert before wrapping. Treating it as a 0-based
    // index meant #1 opened the *second* saver and #N -- the last one -- wrapped
    // to 0 and silently showed the first. That was invisible while the last
    // entry was rarely asked for by number.
    return (((asNum - 1) % TOTAL_ENTRIES) + TOTAL_ENTRIES) % TOTAL_ENTRIES
  }
  const idx = SCREENSAVERS.findIndex((s) => normalize(s.name) === normalize(raw))
  if (idx >= 0) return idx
  const extra = EXTRAS.findIndex((m) => normalize(m.name) === normalize(raw))
  if (extra >= 0) return SCREENSAVERS.length + extra
  // Unmatched names used to fall through to index 0, which silently showed the
  // DVD logo and read as "the saver I asked for is broken".
  console.warn(`[Preview] No screensaver matches "${raw}" -- showing the first one.`)
  return 0
}

function renderList() {
  listEl.innerHTML = ''
  const names = [
    ...listScreensavers(),
    ...EXTRAS.map((m) => `${m.name} (no-signal)`)
  ]
  names.forEach((name, i) => {
    const btn = document.createElement('button')
    btn.textContent = `${i + 1}. ${name}`
    btn.className = i === current ? 'active' : ''
    btn.onclick = () => select(i)
    listEl.appendChild(btn)
  })
}

// A pinned seed from `?seed=...`, or null to let each activation draw its own
// from the wall clock. Pinning is what makes a look reproducible while tuning:
// note the seed the console logs, pass it back, and you get the same frame.
const pinnedSeed = new URLSearchParams(location.search).get('seed')

// Extras are driven here rather than through the registry, so the preview owns
// their lifecycle and must stop the previous one itself.
let activeExtra = null

function stopActiveExtra() {
  if (!activeExtra) return
  try { activeExtra.stop() } catch { /* already torn down */ }
  activeExtra = null
}

function select(index, reseed = false) {
  current = ((index % TOTAL_ENTRIES) + TOTAL_ENTRIES) % TOTAL_ENTRIES
  stopScreensaver()
  stopActiveExtra()
  // `reseed` forces a fresh look even when a seed is pinned, so the S key can
  // still cycle through variations without editing the URL.
  const seed = reseed ? undefined : (pinnedSeed ?? undefined)

  let name
  if (current < SCREENSAVERS.length) {
    name = startScreensaver(current, seed)
  } else {
    const mod = EXTRAS[current - SCREENSAVERS.length]
    activeExtra = mod.create(canvas, seed)
    activeExtra.start()
    name = `${mod.name} (no-signal display)`
  }
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
    // Restart with a brand-new seed. R replays the current look (honouring a
    // pinned ?seed=), S deliberately draws a different one -- which is how you
    // check that a saver's randomised ranges all actually look good.
    case 's': case 'S': select(current, true); break
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
    // Bloom tuning, for savers that use the post chain. Threshold decides how
    // much of the image glows; intensity how strongly. Read the values off the
    // HUD and paste them into the saver once it looks right.
    case '[': adjustBloom('threshold', -0.2); break
    case ']': adjustBloom('threshold', +0.2); break
    case '-': case '_': adjustBloom('intensity', -0.05); break
    case '=': case '+': adjustBloom('intensity', +0.05); break
    case '0': resetBloom(); break
  }
})

// Start in wall mode when asked: `npm run screensaver -- plasma --wall`.
if (/(^|[?&])wall\b/.test(location.search) || /(-|,)wall$/.test(location.hash)) {
  wallMode = true
}

applyWallMode()
select(initialIndex())
updateMode()
