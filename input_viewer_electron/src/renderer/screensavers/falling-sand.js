// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Falling sand — four emitters drop coloured grains that fall, slide over each
 * other and build conical piles, clearing and rebuilding when the heap gets
 * too tall (#94).
 *
 * Cellular like Game of Life, but with gravity, and far more legible at a
 * distance: piles and avalanches are large-scale structure rather than
 * single-cell detail. Unlike Life it also cannot stagnate -- the emitters
 * guarantee continuous motion.
 *
 * The grid is a CPU Uint8Array uploaded as a texture each step. Sand settling
 * is inherently sequential -- a grain must see the result of the grain below it
 * moving -- so a GPU version needs careful multi-pass work for no visual gain
 * at this scale.
 *
 * #94 documents three bugs its prototype hit. All three are guarded here and
 * called out at the code that prevents them; they are the kind that look like
 * rendering faults but are ordering mistakes.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Target cell size in device pixels. Grains want to be individually visible at
// a distance, so this is coarse; the grid is derived from canvas size so the
// wall gets proportionally more cells rather than bigger grains.
const CELL_PX = 5
const MAX_COLS = 900
const MAX_ROWS = 500

// Fixed simulation rate, decoupled from frame rate. #94 asks for ~60/s.
const STEPS_PER_SEC = 60

const EMITTERS = 4
// Grains added per emitter per step.
const GRAINS_PER_STEP = 2

// Clear and restart once the settled heap reaches this fraction of the height.
// #94's second bug was draining the bottom row to "keep it flowing", which meant
// piles never formed -- and the piles are the entire appeal.
//
// Measured: a 20-second build reaches 0.47 with the tallest column at 63 cells
// against a median of 38, i.e. a broad heap rather than a spike. 0.9 lets that
// develop fully before the reset, which keeps the piles on screen for minutes.
const HEAP_LIMIT = 0.9

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uGrid;      // r = emitter index + 1, 0 = empty
uniform vec2 uResolution;
uniform vec2 uGridSize;
uniform vec3 uPhase;
uniform float uLumaScale;
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float cell = texture(uGrid, uv).r * 255.0;

  if (cell < 0.5) {
    // Dim ground rather than black (issue #88).
    fragColor = vec4(palettePerceptual(0.72, uPhase) * 0.03 * uLumaScale, 1.0);
    return;
  }

  // Hue per emitter, so the four streams stay distinguishable as they mix and
  // the layering in a pile is readable.
  float which = cell - 1.0;
  vec3 col = palettePerceptual(0.06 + which * 0.19, uPhase);

  // Slight per-grain variation so a pile reads as granular rather than as a
  // flat region of one colour.
  vec2 g = floor(uv * uGridSize);
  float jitter = fract(sin(dot(g, vec2(12.9898, 78.233))) * 43758.5453);
  col *= 0.82 + 0.28 * jitter;

  col *= uLumaScale;
  fragColor = vec4(col, 1.0);
}
`

/**
 * Advance the sand grid one step.
 *
 * Exported for tests: the three bugs #94 documents are all in this function's
 * ordering, and they are checkable without a GPU.
 *
 * @param {Uint8Array} grid cols*rows, 0 empty, 1..4 emitter index + 1
 * @param {Uint8Array} moved scratch, same size, cleared here
 * @param {number} cols
 * @param {number} rows
 * @param {boolean} leftToRight scan direction for this step
 * @param {() => number} rand
 */
export function stepSand(grid, moved, cols, rows, leftToRight, rand) {
  moved.fill(0)

  // Bottom-up: a grain must see the result of the grain below it having moved,
  // or a column falls one cell per step regardless of what is beneath it.
  for (let y = 1; y < rows; y++) {
    // #94 bug 3b: a fixed scan direction biases every pile the same way, so
    // cones lean. Alternating each step cancels it.
    for (let i = 0; i < cols; i++) {
      const x = leftToRight ? i : cols - 1 - i
      const here = y * cols + x
      const v = grid[here]
      if (v === 0) continue

      // #94 bug 1: without this, a grain that moved down-right is reached again
      // later in the same scan and moves again, repeatedly -- grains skate
      // diagonally across the screen instead of piling.
      if (moved[here]) continue

      const below = here - cols
      if (grid[below] === 0) {
        grid[below] = v
        grid[here] = 0
        moved[below] = 1
        continue
      }

      // Blocked straight down: try the diagonals, in a random order so piles
      // do not develop a consistent lean from always preferring one side.
      const first = rand() < 0.5 ? -1 : 1
      for (const dx of [first, -first]) {
        const nx = x + dx
        if (nx < 0 || nx >= cols) continue
        const diag = below + dx
        // The cell beside it must also be free, or grains squeeze through a
        // one-cell gap diagonally and piles collapse into flat sheets.
        if (grid[diag] === 0 && grid[here + dx] === 0) {
          grid[diag] = v
          grid[here] = 0
          moved[diag] = 1
          break
        }
      }
    }
  }
}

/**
 * Height of the settled heap, as a fraction of the grid.
 *
 * Measures the tallest column that is CONTIGUOUS from the floor, not simply the
 * topmost occupied cell. Grains are emitted at the top row, so a naive
 * top-most-cell measure reads ~1.0 on every step and the heap-limit reset fires
 * continuously -- observed as 4000 resets in 4000 steps, with the grid empty at
 * every sample. Falling grains are in flight, not part of the pile.
 */
export function heapHeight(grid, cols, rows) {
  let tallest = 0
  for (let x = 0; x < cols; x++) {
    let h = 0
    while (h < rows && grid[h * cols + x] !== 0) h++
    if (h > tallest) tallest = h
  }
  return tallest / rows
}

export default {
  name: 'Falling Sand',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null, tex = null
    let cols = 240, rows = 135
    let grid = null, moved = null, pixels = null

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // Sway rate per emitter. #94: the sweep must be SLOW relative to fall
    // speed, or the "stream" is really the emitter's trail smeared sideways and
    // it reads as sand flying horizontally rather than falling.
    const swayRates = Array.from({ length: EMITTERS }, () => rng.range(0.05, 0.13))
    const swayPhases = Array.from({ length: EMITTERS }, () => rng.range(0, Math.PI * 2))

    let accumulator = 0
    let lastTime = 0
    let leftToRight = true
    let elapsed = 0

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        pass = createFullscreenPass(gl, DISPLAY_FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        cols = Math.max(80, Math.min(MAX_COLS, Math.round(canvas.width / CELL_PX)))
        rows = Math.max(60, Math.min(MAX_ROWS, Math.round(canvas.height / CELL_PX)))
        grid = new Uint8Array(cols * rows)
        moved = new Uint8Array(cols * rows)
        pixels = new Uint8Array(cols * rows * 4)

        tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA,
          gl.UNSIGNED_BYTE, null)
        // NEAREST: grains are discrete cells and the grid IS the image;
        // interpolating would smear neighbouring grains into mush.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

        accumulator = 0
        lastTime = 0
        elapsed = 0

        runtime.start((time) => {
          const dt = lastTime === 0 ? 1 / 60 : Math.min(time - lastTime, 0.25)
          lastTime = time
          elapsed += dt
          accumulator += dt * STEPS_PER_SEC

          let steps = Math.min(Math.floor(accumulator), 4)
          accumulator -= steps

          while (steps-- > 0) {
            // Emit. #94 bug 3: each emitter is anchored to its own evenly
            // spaced slot, inset from the edges, and sways only WITHIN it.
            // Swaying around a shared centre stacked all four in the middle,
            // and at x=0.125 the sway pushed the leftmost emitter past column
            // 0, where the clamp piled every grain into one edge column.
            for (let e = 0; e < EMITTERS; e++) {
              const slotCentre = (e + 0.5) / EMITTERS
              const slotHalf = 0.5 / EMITTERS
              // 0.55 keeps the sway strictly inside the slot, so neighbouring
              // streams never overlap and none can reach a canvas edge.
              const sway = Math.sin(elapsed * swayRates[e] * Math.PI * 2 + swayPhases[e])
              const fx = slotCentre + sway * slotHalf * 0.55
              const x = Math.max(1, Math.min(cols - 2, Math.round(fx * cols)))
              for (let g = 0; g < GRAINS_PER_STEP; g++) {
                const gx = Math.max(0, Math.min(cols - 1, x + (g === 0 ? 0 : (rng.next() < 0.5 ? -1 : 1))))
                const idx = (rows - 1) * cols + gx
                if (grid[idx] === 0) grid[idx] = e + 1
              }
            }

            stepSand(grid, moved, cols, rows, leftToRight, () => rng.next())
            leftToRight = !leftToRight

            // #94 bug 2: let the heap build, then clear. Draining the bottom
            // row to keep things flowing means piles never form at all.
            if (heapHeight(grid, cols, rows) > HEAP_LIMIT) grid.fill(0)
          }

          // Upload the grid. Only the red channel carries data; the display
          // shader derives colour from it.
          for (let i = 0; i < grid.length; i++) {
            pixels[i * 4] = grid[i]
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
            g.uniform1i(u('uGrid'), 0)
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform2f(u('uGridSize'), cols, rows)
            g.uniform3f(u('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
          })
        })
      },
      stop() {
        if (tex && gl) { gl.deleteTexture(tex); tex = null }
        if (pass) { pass.destroy(); pass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        grid = moved = pixels = null
      }
    }
  }
}
