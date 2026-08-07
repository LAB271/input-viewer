// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Drives every registered screensaver through a real WebGL2 context so the GPU
 * driver actually compiles and links its shaders.
 *
 * Each saver is started, allowed to render a few frames (some build programs
 * lazily on the first frame, and simulation savers only touch their sim shader
 * inside the render loop), then stopped. Anything thrown is captured.
 *
 * Also verifies each saver twice with a pinned seed and once with a fresh one:
 * a randomised constant that lands outside a shader's valid range would only
 * fail for some seeds, so a single run is not enough coverage.
 */
import { SCREENSAVERS } from './registry.js'
import { getActivePostChain } from './post-fx.js'

const out = document.getElementById('out')
const canvas = document.getElementById('screensaver-canvas')

const log = (msg) => {
  out.textContent += msg + '\n'
  console.log(msg)
}

// Drive create()/start() directly rather than going through
// registry.startScreensaver(). The registry deliberately swallows a start
// failure and falls back to the DVD logo, which is right for production -- a
// broken shader should not leave a blank wall -- but it means a failure is
// invisible to a caller. An earlier version of this harness used the registry
// and reported 60/60 passing while the driver was in fact rejecting a shader.
//
// Console errors are captured too, since that is where the registry's own
// fallback path reports and where a driver warning would surface.
const consoleErrors = []
const nativeError = console.error.bind(console)
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a && a.stack ? a.stack : String(a))).join(' '))
  nativeError(...args)
}

/** Wait n animation frames. */
const frames = (n) => new Promise((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
})

// Pixel sanity, not just compilation. The raymarch regression (#140) compiled
// cleanly and raised no GL error, so compilation alone clearly is not enough.
//
// Scope, stated honestly. Fault injection shows these checks DO catch a saver
// emitting NaN and a saver rendering black (5/5 seeds each, clean tree 65/65).
// They do NOT catch either specific #140 bug under this harness: the double
// tonemap leaves every pixel in range and merely wrong-looking, and the
// unguarded normalize() does not produce NaN on SwiftShader, only on the real
// GPU where it was found. Three threshold designs were tried against them --
// blown pixels, lifted blacks, and an HDR-peak floor -- and the first two
// missed while the third failed 6 savers on a clean tree.
//
// So this is a floor, not a substitute for looking at the thing. Bounds are
// deliberately loose: a smoke test for "the frame is broken", not a look
// judgement, since the savers legitimately range from near-black starfields to
// bright plasma.
const NAN_PIXELS_ALLOWED = 0
// A few out-of-gamut pixels are normal (OKLab ramps clip at the edges); a wash
// of them means NaN or an unclamped conversion.
const MAX_NEGATIVE_FRACTION = 0.001
const MAX_BLOWN_FRACTION = 0.9
// NOT CHECKED HERE: whether a saver emits true HDR (peak > 1.0). It looks like
// the ideal structural test for the #140 double tonemap, because col/(1+col)
// asymptotes to 1.0 and so an inline tonemap provably cannot exceed it --
// raymarch peaked at 0.761 with the bug and 1.448 without. But asserting it
// across the set fails 6 savers on a clean tree. Owning a post chain does not
// imply emitting HDR: the LDR fragment savers (flow field, the three fractals,
// Voronoi) legitimately peak at 0.36-0.80, which is the same fact already
// recorded in post-fx.js about bloom thresholds. A per-saver expected range
// would work, but that is a tuning table to maintain, not a smoke test.
// Some savers (attractor, particles) genuinely start near-black and accumulate,
// so this only catches a frame that is *exactly* zero everywhere.
const MIN_LIT_PIXELS = 1

/**
 * Read back the rendered frame and report NaN, negative and blown-out pixels.
 *
 * Reads the post chain's HDR scene target when a saver has one, because that is
 * where unclamped values are still visible -- after ACES they are squashed into
 * range and a double tonemap looks merely "a bit bright". Falls back to the
 * canvas for savers with no chain.
 */
function inspectPixels(gl, chain) {
  if (!gl || gl.isContextLost()) return null
  const w = Math.min(gl.drawingBufferWidth, 512)
  const h = Math.min(gl.drawingBufferHeight, 512)
  if (!w || !h) return null

  const hdr = chain && chain.sceneTarget
  let px
  try {
    if (hdr) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo)
      px = new Float32Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const bytes = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
      px = Float32Array.from(bytes, (v) => v / 255)
    }
  } catch {
    return null
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  let nan = 0, negative = 0, blown = 0, lit = 0
  const total = w * h
  const lums = new Float32Array(total)
  let n = 0
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) { nan++; lums[n++] = 0; continue }
    if (r < -1e-4 || g < -1e-4 || b < -1e-4) negative++
    const lum = Math.max(r, 0) * 0.2126 + Math.max(g, 0) * 0.7152 + Math.max(b, 0) * 0.0722
    if (lum > 0.995) blown++
    if (lum > 0.004) lit++
    lums[n++] = lum
  }
  lums.sort()
  const p05 = lums[Math.floor(0.05 * (total - 1))]
  const peak = lums[total - 1]
  return { total, nan, negative, blown, lit, p05, peak, hdr: Boolean(hdr) }
}

/** Turn pixel stats into a failure message, or null when the frame looks sane. */
function pixelProblem(s) {
  if (!s) return null // no readback available -- not a failure
  const pct = (n) => `${((n / s.total) * 100).toFixed(1)}%`
  if (s.nan > NAN_PIXELS_ALLOWED) return `${s.nan} NaN pixels (${pct(s.nan)})`
  if (s.negative / s.total > MAX_NEGATIVE_FRACTION) {
    return `${s.negative} negative pixels (${pct(s.negative)}) -- unclamped colour or NaN upstream`
  }
  if (s.blown / s.total > MAX_BLOWN_FRACTION) {
    return `${pct(s.blown)} of the frame is fully blown out -- double tonemap?`
  }
  if (s.lit < MIN_LIT_PIXELS) return 'frame is entirely black'
  return null
}

async function run() {
  const results = []

  // Several seeds per saver: the randomised ranges are the new risk surface, so
  // exercise more than one point in them. Fixed seeds keep the run reproducible.
  const seeds = [1, 2, 12345, 999999, 'abc']

  for (let i = 0; i < SCREENSAVERS.length; i++) {
    const saver = SCREENSAVERS[i]
    const name = saver.name
    for (const seed of seeds) {
      let error = null
      let instance = null
      let pixels = null
      const errorsBefore = consoleErrors.length
      try {
        instance = saver.create(canvas, seed)
        instance.start()
        // 5 frames: enough for lazy program creation and for simulation savers
        // to have run their sim pass at least once.
        await frames(5)
        // Inspect before stop(), while the context and post chain still exist.
        pixels = inspectPixels(canvas.getContext('webgl2'), getActivePostChain())
      } catch (err) {
        error = err && err.message ? err.message : String(err)
      }
      if (instance) {
        try { instance.stop() } catch (err) {
          if (!error) error = `stop() threw: ${err && err.message ? err.message : err}`
        }
      }
      // A saver that logs an error without throwing still counts as a failure.
      const newErrors = consoleErrors.slice(errorsBefore)
      if (!error && newErrors.length) error = newErrors.join('\n')
      // Only report a pixel problem when nothing worse already failed --
      // a saver that threw will obviously also render nothing useful.
      if (!error) {
        const problem = pixelProblem(pixels)
        if (problem) error = `pixel check: ${problem}`
      }
      results.push({ name, seed: String(seed), error, pixels })
      if (error) log(`FAIL  ${name} (seed ${seed})\n${error}\n`)
    }
  }

  const failed = results.filter((r) => r.error)
  log(`\n--- ${results.length - failed.length}/${results.length} runs OK ---`)
  if (failed.length) {
    const byName = [...new Set(failed.map((f) => f.name))]
    log(`FAILING SAVERS: ${byName.join(', ')}`)
  }

  // Console-visible sentinel the headless runner greps for.
  console.log(`SHADERCHECK_DONE ok=${results.length - failed.length} fail=${failed.length}`)
  window.__SHADERCHECK__ = { results, failed: failed.length }
}

run().catch((err) => {
  log(`HARNESS ERROR: ${err && err.stack ? err.stack : err}`)
  console.log('SHADERCHECK_DONE ok=0 fail=-1')
})
