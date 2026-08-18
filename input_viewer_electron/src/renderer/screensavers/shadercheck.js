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
import { STRUCTURE_BASELINES } from './structure-baselines.js'

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

// Per-saver structure baselines (issue #156).
//
// Edge density -- the fraction of horizontally adjacent pixels differing by
// more than 6% luminance -- is what would have caught the physarum failure,
// where the simulation was correct but the display pass rendered a flat
// gradient. It scored exactly 0.000 while the frame looked "lit".
//
// It CANNOT be a global threshold, and measuring the whole set is what shows
// why: Reaction Diffusion legitimately scores 0.000 too, and Metaballs 0.0013,
// while White Particles scores 0.6749. Any floor above zero false-positives on
// healthy savers; a floor of zero catches nothing.
//
// So the baseline is per saver, recorded from a healthy run, and the check is
// for a large RELATIVE drop rather than an absolute value. Regenerate with
// `npm run baselines` after a deliberate visual change.
// How far below its baseline a saver may drift before failing. Generous,
// because these are stochastic: a different seed genuinely moves the number.
// The failure being guarded is a collapse to near-zero, not a wobble.
const STRUCTURE_DROP_TOLERANCE = 0.35

// Frame counts at which the density is sampled; the check uses the MAX (#192).
//
// A single reading at frame 5 made this check fail nondeterministically. Two
// consecutive runs on an unchanged tree gave DVD Logo 0.001695 (below its floor,
// FAIL) and 0.002765 (at its baseline, pass). The cause is not drift: a saver
// that is a small sprite on a large black field has an edge density dominated by
// WHERE the sprite happens to be, and at frame 5 that is a function of real
// elapsed wall-clock time under SwiftShader. The measurement is bimodal.
//
// Sampling a window and taking the max asks the question the check actually
// cares about -- "does this saver put structure on screen at all" -- instead of
// "was there structure at one arbitrary instant". Measured over the window,
// DVD Logo reaches 0.0057 and Julia Set 0.0099, against single-sample readings
// of 0.0025 and 0.0026.
//
// Kept deliberately short. Rendering dominates the suite's runtime -- 145 runs
// at SwiftShader's ~10fps -- so the window length sets the wall-clock cost
// roughly linearly. This window measured 120s per run over ten consecutive
// runs, against about 90s for the single frame-5 sample it replaces. Sampling
// further out (frame 20, frame 80) is more stable still but costs
// proportionally more and caught no additional failures on this set.
//
// Do not shrink this to one entry: a single reading is the bug in #192.
const STRUCTURE_SAMPLE_FRAMES = [5, 12]

// Smallest absolute drop below baseline that counts as a collapse.
//
// The relative test alone cannot work at the bottom of the range. A saver whose
// healthy density is 0.002 has frame-to-frame noise wider than the 35% band, so
// the band is measuring noise rather than health -- which is precisely how the
// flake in #192 arose. Requiring the drop to be absolutely meaningful as well as
// relatively large makes that limit explicit instead of asserting a precision
// the measurement does not have.
//
// 0.0015 is chosen so a total collapse is still caught for every saver in the
// set: the lowest non-zero baseline is Starfield Warp at 0.0008 -- below this
// margin, and so already unprotected either way -- while Mandelbrot at 0.0019
// going to 0 is a drop of 0.0019 and still fails. What it deliberately stops
// catching is DVD Logo wobbling from 0.0028 to 0.0017, a drop of 0.0011.
const STRUCTURE_MIN_ABS_DROP = 0.0015

// Minimum luminance spread (p99.9 - p05) for a saver that should be drawing
// something (#227).
//
// This exists because STRUCTURE_MIN_ABS_DROP creates a blind spot at the bottom
// of the density range: a saver whose baseline is under that margin cannot
// produce a drop large enough to trip the relative check, so it is unprotected
// against going flat. Plasma sits at 0.0001 and Starfield Warp at 0.0011.
//
// Unlike the edge-density rule this is an ABSOLUTE floor with no per-saver
// baseline, which is only safe because the measured range is so wide. Across all
// 30 savers the lowest spread belonging to a saver with a non-zero baseline is
// Julia Set at 0.1004; the only two zeroes are Wave Tank and Tree Growth, which
// have a zero edge-density baseline and are already skipped for the same reason
// (they need seconds to develop). 0.02 is a fifth of the smallest real value, so
// there is a 5x margin before a healthy saver could reach it.
const UNIFORM_SPREAD_MIN = 0.02

// Baseline staleness bounds (#227). A measured density this far from its baseline
// means the BASELINE is wrong, not the frame.
//
// The check only ever fails on a drop, so a baseline that sits far BELOW what the
// saver really produces is invisible -- and that is not hypothetical. Truchet
// Tiles carried 0.0957, inherited from main's single quarter arcs, while its
// multi-strand bundles measure 0.397. A collapse to a quarter of the real density
// would have passed, silently, and nothing said so.
//
// 4x either way, and that number is measured rather than picked. 2x was tried
// first and flagged two savers whose measurement is simply noisy at this sample
// window: Raymarch Fractal read 0.0082 in one run and 0.0185 in the next (2.3x)
// and Reaction Diffusion likewise 2.3x -- both bimodal at frames 5/12, which is
// the effect #192 was filed over. Most savers reproduce to within 1-2%, but the
// threshold has to clear the worst one, not the median.
//
// 4x still catches every real case: Truchet's historical gap was 4.1x, and the
// three found on main when this check was added were 4.6x, 27.8x and 129.4x.
//
// REPORTED, NOT FAILED, and that is deliberate. A stale baseline is a defect in
// the check's configuration rather than in the frame under test, so failing on it
// would turn every unrelated PR red until somebody fixed a saver they had not
// touched. Warning keeps it visible without holding the repo hostage.
const STALE_RATIO = 4.0

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
  // Edge density: horizontally adjacent pixels differing by more than 6%
  // luminance. Computed on the unsorted grid, before lums is sorted below.
  let edges = 0, comparisons = 0
  for (let y = 0; y < h; y += 2) {
    for (let x = 1; x < w; x++) {
      const a = lums[y * w + x - 1]
      const b = lums[y * w + x]
      comparisons++
      if (Math.abs(a - b) > 0.06) edges++
    }
  }
  const edgeDensity = comparisons === 0 ? 0 : edges / comparisons


  lums.sort()
  const p05 = lums[Math.floor(0.05 * (total - 1))]
  const peak = lums[total - 1]
  // Luminance spread, for the uniformity check (#227). This is the measurement
  // edge density cannot make: a frame can be smooth (no edges) and still be a
  // perfectly good picture, but it cannot be UNIFORM and be one.
  //
  // p99.9 rather than p95 or the peak, and that choice is measured, not assumed:
  //
  //   p95 - p05   zero for 5 healthy savers -- DVD Logo, Strange Attractor,
  //               Falling Sand, Wave Tank, Tree Growth. Their subject covers
  //               under 5% of the frame, so both percentiles sit in the
  //               background and the statistic cannot tell a sparse subject from
  //               a dead frame. Unusable.
  //   peak - p05  works, but one stray bright pixel is enough to mask a dead
  //               frame, which is the failure this is meant to catch.
  //   p99.9 - p05 non-zero for every saver that has a non-zero baseline. At this
  //               harness resolution 0.1% of the frame is thousands of pixels, so
  //               a real subject registers and an outlier does not.
  const p999 = lums[Math.floor(0.999 * (total - 1))]
  const spread = p999 - p05
  return { total, nan, negative, blown, lit, p05, p999, peak, spread, edgeDensity, hdr: Boolean(hdr) }
}

/** Turn pixel stats into a failure message, or null when the frame looks sane. */
function pixelProblem(s, name) {
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

  // Structure, against this saver's own baseline (#156). A global threshold
  // cannot work here: Reaction Diffusion legitimately scores 0.000 while White
  // Particles scores 0.62.
  const baseline = STRUCTURE_BASELINES[name]

  // Uniformity, before the edge-density rule (#227). A uniform frame should be
  // reported as uniform rather than as a structure collapse, and this catches the
  // case the edge-density rule cannot see at all: a saver whose baseline is below
  // STRUCTURE_MIN_ABS_DROP going completely flat. Gated on a non-zero baseline,
  // the same gate the rule below uses, so the two savers that legitimately start
  // blank stay exempt.
  if (typeof baseline === 'number' && baseline > 0 && s.spread < UNIFORM_SPREAD_MIN) {
    return `frame is uniform: luminance spread ${s.spread.toFixed(4)} is below ` +
      `${UNIFORM_SPREAD_MIN} (p05 ${s.p05.toFixed(4)}, p99.9 ${s.p999.toFixed(4)}). ` +
      'The frame renders and is not black, but nothing varies across it -- a ' +
      'flattened display pass, or a simulation that never started.'
  }

  if (typeof baseline === 'number' && baseline > 0) {
    const floor = baseline * (1 - STRUCTURE_DROP_TOLERANCE)
    // Both conditions, not either (#192). The relative test says "this is a big
    // fraction of what it should be"; the absolute one says "and the difference
    // is larger than this measurement's own noise". At the bottom of the range
    // only the pair is meaningful -- see STRUCTURE_MIN_ABS_DROP.
    const drop = baseline - s.edgeDensity
    if (s.edgeDensity < floor && drop > STRUCTURE_MIN_ABS_DROP) {
      return `structure collapsed: edge density ${s.edgeDensity.toFixed(4)} is below ` +
        `${floor.toFixed(4)} (baseline ${baseline}, drop ${drop.toFixed(4)}). The frame ` +
        'renders but has lost its detail -- a flattened display pass or a broken ' +
        'simulation.'
    }
  }
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
        // Sample a window rather than one instant, and keep the frame with the
        // most structure (#192). The first sample is at frame 5 -- enough for
        // lazy program creation and for a simulation saver to have run its sim
        // pass at least once -- so the other checks see the same frame they
        // always did; only the structure figure benefits from the window.
        //
        // Inspect before stop(), while the context and post chain still exist.
        let waited = 0
        for (const at of STRUCTURE_SAMPLE_FRAMES) {
          await frames(at - waited)
          waited = at
          const sample = inspectPixels(canvas.getContext('webgl2'), getActivePostChain())
          if (!sample) continue
          // Keep the first sample as the basis for the NaN/blown/lit checks, and
          // raise only its edge density. Those checks want a real frame; taking
          // a per-field max across frames would invent a frame that never
          // existed and could mask a fault that appears in one of them.
          if (!pixels) pixels = sample
          else {
            // Raise edge density and spread independently. A saver still
            // developing at frame 5 should be judged on its best sampled frame
            // for each, and neither feeds the NaN/blown/lit checks.
            if (sample.edgeDensity > pixels.edgeDensity) {
              pixels = { ...pixels, edgeDensity: sample.edgeDensity }
            }
            if (sample.spread > pixels.spread) {
              pixels = { ...pixels, spread: sample.spread }
            }
          }
        }
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
        const problem = pixelProblem(pixels, name)
        if (problem) error = `pixel check: ${problem}`
      }
      results.push({ name, seed: String(seed), error, pixels })
      if (error) log(`FAIL  ${name} (seed ${seed})\n${error}\n`)
    }
  }

  // Emit measured edge densities so baselines can be regenerated from THIS
  // harness. Measuring them anywhere else bakes in that context's resolution:
  // edge density is resolution-dependent, and baselines taken at 600x300 while
  // the harness runs full-viewport produced 13 false positives.
  const densities = {}
  for (const r of results) {
    if (!r.pixels || typeof r.pixels.edgeDensity !== 'number') continue
    const prev = densities[r.name]
    // Minimum across seeds: the baseline must not fail the unluckiest run.
    densities[r.name] = prev === undefined
      ? r.pixels.edgeDensity
      : Math.min(prev, r.pixels.edgeDensity)
  }
  console.log('SHADERCHECK_DENSITIES ' + JSON.stringify(densities))

  // Baseline staleness (#227), in both directions. Uses the same per-saver minimum
  // across seeds that the baselines themselves are generated from, so this
  // compares like with like.
  const stale = []
  for (const [name, measured] of Object.entries(densities)) {
    const baseline = STRUCTURE_BASELINES[name]
    if (typeof baseline !== 'number' || baseline <= 0) continue
    const ratio = measured / baseline
    if (ratio >= STALE_RATIO || ratio <= 1 / STALE_RATIO) {
      stale.push({ name, baseline, measured: Number(measured.toFixed(4)), ratio: Number(ratio.toFixed(2)) })
    }
  }
  console.log('SHADERCHECK_STALE ' + JSON.stringify(stale))

  if (stale.length) {
    log(`\n--- ${stale.length} stale baseline(s): measured density is over ${STALE_RATIO}x from the baseline ---`)
    for (const t of stale) {
      const dir = t.ratio >= STALE_RATIO
        ? 'baseline is too LOW -- the saver is under-protected against a real collapse'
        : 'baseline is too HIGH -- the saver is close to failing on every run'
      log(`  ${t.name}: baseline ${t.baseline}, measured ${t.measured} (${t.ratio}x) -- ${dir}`)
    }
    log('  Not a failure: a stale baseline is a config defect, not a bad frame. Update')
    log('  only the affected saver\'s line; `npm run baselines` rewrites all 30.')
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
