// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Frost — dendritic ice creeping in from the edges, branching into feathered
 * ferns, then holding and resetting. Grown with diffusion-limited aggregation
 * (#100).
 *
 * Two things the current set lacks, and this has both: **progression** (a
 * beginning, middle and end, then a reset, where almost every other saver is in
 * a steady state) and **brightness** (bright white-on-dark with fine
 * high-contrast detail, which per #88 should survive ambient light far better
 * than the dim particle savers).
 *
 * **Use DLA, not frontier growth.** #100 is emphatic and it is right: picking a
 * cell adjacent to existing ice and maybe filling it cannot produce dendrites,
 * because it fills space. The scarcity of random walkers reaching interior gaps
 * is *what creates branching* -- protruding tips shadow the space behind them.
 *
 * Measuring whether it is actually dendritic matters more than looking at it: a
 * dense mass and a fern both read as "white-ish" at a glance. #100's metric is
 * perimeter/area, the fraction of ice cells having an empty 4-neighbour:
 *
 *   ~1.0  every cell on the boundary  -> dendritic
 *   ~0.5  half the cells interior     -> solid mass
 *
 * A finding NOT in the issue, measured while validating this: **the walker must
 * step one axis at a time.** A diagonal walk (both axes every step) reaches
 * interior gaps too easily and fills them, so the ratio degrades as the cluster
 * grows -- 0.87 at 1% coverage down to 0.77 at 6%. The 4-neighbour walk holds
 * flat at 0.93-0.95. The diagonal version still *looks* like branching ice, so
 * it would pass a screenshot review and go dense at the size the wall runs.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Cells per device pixel. Fine detail is the whole appeal, so this is smaller
// than the sand grid, capped so the wall does not become throughput-bound.
const CELL_PX = 3
const MAX_COLS = 1200
const MAX_ROWS = 500

// Walkers released per frame. Growth rate, effectively.
const WALKERS_PER_FRAME = 220

// Coverage at which to hold, then reset.
//
// #100 measured the dendritic ratio collapsing to 0.61 by 12% coverage on a
// 5:1 grid, while a squarer 480x300 held 0.94 out to 17%. So the stop threshold
// must scale with aspect ratio rather than being a constant: a flat threshold
// made the wall look right only because it had not reached it yet, while a
// window filled with dense noise.
const COVERAGE_SQUARE = 0.16
const COVERAGE_WIDE = 0.075
// How long the finished pattern holds before melting away.
const HOLD_SECONDS = 6

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uIce;      // r = age (0 = empty, else 1..255 arrival order)
uniform vec2 uResolution;
uniform vec2 uGridSize;
uniform vec3 uPhase;
uniform float uLumaScale;
uniform float uMelt;         // 0 = intact, 1 = fully melted
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float age = texture(uIce, uv).r;

  // Cold background: a very dark blue rather than black, so the ferns have
  // something to sit against under ambient light (issue #88).
  vec3 bg = palettePerceptual(0.62 + uPhase.x, uPhase) * 0.035;

  if (age < 0.004) {
    fragColor = vec4(bg * uLumaScale, 1.0);
    return;
  }

  // Melt from the newest growth backwards, so the pattern retreats the way it
  // arrived rather than dissolving uniformly.
  if (uMelt > 0.0 && age > 1.0 - uMelt) {
    fragColor = vec4(bg * uLumaScale, 1.0);
    return;
  }

  // Older ice is denser and whiter; the growing tips keep a colder tint. That
  // gradient is what makes the ferns read as having grown rather than appeared.
  vec3 core = palettePerceptual(0.52 + uPhase.x, uPhase);
  vec3 col = mix(vec3(0.86, 0.94, 1.0), core, age * 0.55);

  // Crystalline sparkle: a per-cell hash lifts a few cells, which reads as
  // faceting at a distance without needing finer geometry.
  vec2 g = floor(uv * uGridSize);
  float h = fract(sin(dot(g, vec2(12.9898, 78.233))) * 43758.5453);
  col *= 0.78 + 0.42 * h;

  col *= uLumaScale;
  fragColor = vec4(col, 1.0);
}
`

/**
 * Fraction of ice cells with at least one empty 4-neighbour.
 *
 * #100's dendritic metric, exported because it is the only reliable way to tell
 * a fern from a mass -- both look "white-ish" in a screenshot.
 *
 * @param {Uint8Array} ice
 * @param {number} cols
 * @param {number} rows
 * @returns {{ice: number, ratio: number}}
 */
export function perimeterRatio(ice, cols, rows) {
  let count = 0
  let perimeter = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (!ice[i]) continue
      count++
      if (x === 0 || !ice[i - 1] ||
          x === cols - 1 || !ice[i + 1] ||
          y === 0 || !ice[i - cols] ||
          y === rows - 1 || !ice[i + cols]) {
        perimeter++
      }
    }
  }
  return { ice: count, ratio: count === 0 ? 0 : perimeter / count }
}

/**
 * Release one walker and let it stick, or give up.
 *
 * Exported for tests. Every guard here corresponds to a bug #100 documents, and
 * all four looked like tuning problems while being structural.
 *
 * @returns {number} index where it stuck, or -1
 */
export function releaseWalker(ice, cols, rows, depthTop, depthBottom, band, minFlight, rand) {
  // #100 bug 5: choosing uniformly among four sides gives the short edges of a
  // 5:1 grid roughly 5x the per-cell walker density, so one end races ahead
  // while the long edges stay a fringe. Weight by edge length.
  const horizontal = rand() < cols / (cols + rows)
  let x, y

  if (horizontal) {
    x = Math.floor(rand() * cols)
    const fromTop = rand() < 0.5
    // #100 bug 4: a single global max depth per edge lets one lucky spike set a
    // deep band for the whole edge, releasing walkers *inside* the cluster
    // where they cement the interior. Per-column local depth instead.
    const local = fromTop ? depthTop[x] : depthBottom[x]
    const base = local >= 0 ? local : 0
    // #100 bugs 2 and 3 together: release near the frontier, because random
    // walk search time grows with area and uniform release almost never finds
    // the cluster at 450k cells -- but not too near, or walkers weld on contact
    // into a solid bar. A wide band is the compromise.
    const offset = base + 1 + Math.floor(rand() * band)
    y = fromTop ? Math.min(rows - 1, offset) : Math.max(0, rows - 1 - offset)
  } else {
    y = Math.floor(rand() * rows)
    const offset = 1 + Math.floor(rand() * band)
    x = rand() < 0.5 ? Math.min(cols - 1, offset) : Math.max(0, cols - 1 - offset)
  }

  const maxSteps = band * 60
  for (let step = 1; step <= maxSteps; step++) {
    // ONE axis per step. A diagonal walk reaches interior gaps too easily and
    // densifies the cluster: measured 0.87 -> 0.77 perimeter ratio from 1% to
    // 6% coverage, versus 0.93-0.95 holding flat here. Not in #100; found while
    // validating the algorithm against its own metric.
    if (rand() < 0.5) x += rand() < 0.5 ? -1 : 1
    else y += rand() < 0.5 ? -1 : 1

    if (x < 0 || x >= cols || y < 0 || y >= rows) return -1

    // #100 bug 3: a minimum free flight before sticking is what stops a walker
    // spawned beside ice from welding immediately. Without it the release band
    // becomes a solid white bar at the outermost row.
    if (step < minFlight) continue

    const i = y * cols + x
    if (ice[i]) continue

    if ((x > 0 && ice[i - 1]) || (x < cols - 1 && ice[i + 1]) ||
        (y > 0 && ice[i - cols]) || (y < rows - 1 && ice[i + cols])) {
      return i
    }
  }
  return -1
}

export default {
  name: 'Frost',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null, tex = null
    let cols = 320, rows = 180
    let ice = null, pixels = null
    let depthTop = null, depthBottom = null
    let band = 0, minFlight = 0
    let iceCount = 0, target = 0, arrival = 0
    let holdUntil = 0, melt = 0
    let elapsed = 0, lastTime = 0

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]

    function seedNuclei() {
      ice.fill(0)
      depthTop.fill(-1)
      depthBottom.fill(-1)
      iceCount = 0
      arrival = 0
      melt = 0
      holdUntil = 0
      // Nuclei along the edges, weighted by edge length for the same reason
      // walkers are.
      const nuclei = Math.max(10, Math.round((cols + rows) / 30))
      for (let n = 0; n < nuclei; n++) {
        let i
        if (rng.next() < cols / (cols + rows)) {
          const x = rng.int(0, cols - 1)
          i = rng.chance(0.5) ? x : (rows - 1) * cols + x
        } else {
          const y = rng.int(0, rows - 1)
          i = y * cols + (rng.chance(0.5) ? 0 : cols - 1)
        }
        if (!ice[i]) { ice[i] = 1; iceCount++ }
      }
    }

    function recordDepth(index) {
      const x = index % cols
      const y = Math.floor(index / cols)
      if (y < rows / 2) {
        if (y > depthTop[x]) depthTop[x] = y
      } else if (rows - 1 - y > depthBottom[x]) {
        depthBottom[x] = rows - 1 - y
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        pass = createFullscreenPass(gl, DISPLAY_FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        cols = Math.max(120, Math.min(MAX_COLS, Math.round(canvas.width / CELL_PX)))
        rows = Math.max(80, Math.min(MAX_ROWS, Math.round(canvas.height / CELL_PX)))
        ice = new Uint8Array(cols * rows)
        pixels = new Uint8Array(cols * rows * 4)
        depthTop = new Int16Array(cols)
        depthBottom = new Int16Array(cols)

        band = Math.max(8, Math.round(Math.min(cols, rows) * 0.5))
        minFlight = Math.max(4, Math.round(band * 0.4))

        // Coverage target scaled by aspect, per #100's measurements: a wide grid
        // goes dense far sooner than a squarer one.
        const aspect = cols / rows
        const t = Math.min(1, Math.max(0, (aspect - 1.6) / (5 - 1.6)))
        target = Math.round(cols * rows * (COVERAGE_SQUARE + (COVERAGE_WIDE - COVERAGE_SQUARE) * t))

        seedNuclei()
        elapsed = 0
        lastTime = 0

        tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA,
          gl.UNSIGNED_BYTE, null)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

        runtime.start((time) => {
          const dt = lastTime === 0 ? 1 / 60 : Math.min(time - lastTime, 0.25)
          lastTime = time
          elapsed += dt

          if (iceCount < target) {
            for (let w = 0; w < WALKERS_PER_FRAME; w++) {
              const at = releaseWalker(ice, cols, rows, depthTop, depthBottom,
                band, minFlight, () => rng.next())
              if (at < 0) continue
              // Age stored as arrival order, so the display can tint tips
              // differently from the core and melt newest-first.
              arrival = Math.min(254, arrival + (255 / target) * 1.0)
              ice[at] = Math.max(1, Math.round(arrival))
              iceCount++
              recordDepth(at)
              if (iceCount >= target) break
            }
            if (iceCount >= target) holdUntil = elapsed + HOLD_SECONDS
          } else if (elapsed < holdUntil) {
            melt = 0
          } else {
            // Melt away, then start a fresh pattern.
            melt = Math.min(1, melt + dt * 0.5)
            if (melt >= 1) seedNuclei()
          }

          for (let i = 0; i < ice.length; i++) {
            pixels[i * 4] = ice[i]
            pixels[i * 4 + 3] = 255
          }
          gl.bindTexture(gl.TEXTURE_2D, tex)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA,
            gl.UNSIGNED_BYTE, pixels)

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          pass.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, tex)
            g.uniform1i(u('uIce'), 0)
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform2f(u('uGridSize'), cols, rows)
            g.uniform3f(u('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
            g.uniform1f(u('uMelt'), melt)
          })
        })
      },
      stop() {
        if (tex && gl) { gl.deleteTexture(tex); tex = null }
        if (pass) { pass.destroy(); pass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        ice = pixels = depthTop = depthBottom = null
      }
    }
  }
}
