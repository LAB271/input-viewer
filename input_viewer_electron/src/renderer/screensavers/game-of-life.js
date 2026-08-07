// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Conway's Game of Life — B3/S23 on a toroidal grid (issue #90).
 *
 * Runs entirely on the GPU as a ping-pong texture, the same read-neighbours/
 * write-next shape as reaction-diffusion.js. The alternative, a CPU
 * Uint8Array double-buffer, is easier to debug but at wall scale means roughly
 * 800k cells per generation in JS; the GPU path costs the same at any grid size.
 *
 * Three things here are load-bearing rather than incidental:
 *
 * 1. **Simulation rate is decoupled from frame rate.** Stepping once per
 *    animation frame runs 60 generations/sec, which reads as static noise
 *    rather than as evolving structure. Generations accumulate against elapsed
 *    time and step at a fixed rate, while rendering every frame.
 *
 * 2. **Wrapping is done in the shader, not by the sampler.** createFloatTarget
 *    hardcodes CLAMP_TO_EDGE, and changing it would alter reaction-diffusion,
 *    which relies on clamping. fract() on the sample coordinate gives a true
 *    torus without touching the shared helper.
 *
 * 3. **Stagnation handling is not optional.** Life reliably converges to still
 *    lifes and oscillators. Without reseeding, the wall freezes on a static
 *    image, which to anyone walking past looks like the app has crashed.
 *
 * Per-activation variation: seed density, palette rotation, grid cell size and
 * the reseed cadence all shift.
 */
import {
  createGLRuntime,
  createFullscreenPass,
  createPingPong,
  luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Target cell size in device pixels. 6 keeps gliders legible across a room
// while still giving the 6000x1200 wall a grid wide enough for large-scale
// structure to form. Derived from canvas size rather than hardcoded so the
// wall gets a proportionally wider grid, not a stretched one.
const TARGET_CELL_PX = 6
// Caps the grid on very large canvases. 6000/6 = 1000 across, which is the
// point of this bound: past it the cells are too small to read at distance and
// the population statistics stop producing visible structure.
const MAX_CELLS = 1024
const MIN_CELLS = 48

// Fixed simulation rate. Below ~8 the motion looks like a slideshow; above ~15
// the eye cannot track a glider across the screen.
const GENERATIONS_PER_SEC = 12

// Stagnation detection. Life's still lifes and oscillators mean "population
// stopped changing" is the reliable signal, but a period-2 oscillator has a
// *constant* population while still flickering forever, so a plain equality
// test on consecutive generations would never fire on a blinker field. Compare
// against a window instead: if the population has not left a narrow band for
// this many generations, the board is done evolving in any interesting way.
const STAGNATION_WINDOW = 90
const STAGNATION_BAND = 0.012
// Belt and braces, per #58. An oscillator-only board technically changes
// forever, so a hard cap guarantees a reseed even if the band test is fooled.
const MAX_GENERATIONS = 700

// Population is read back from the GPU to detect stagnation, which is a
// pipeline stall, so it is done sparingly rather than every generation.
const POPULATION_SAMPLE_EVERY = 10

const SIM_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uTexel;
out vec4 fragColor;

// Toroidal neighbour fetch. fract() wraps the coordinate into [0,1) regardless
// of the texture's own wrap mode, which is what makes the torus work despite
// createFloatTarget hardcoding CLAMP_TO_EDGE. Without this a glider reaching an
// edge would smear against the clamped border instead of re-entering opposite.
float cellAt(vec2 uv, vec2 offset) {
  return texture(uState, fract(uv + offset * uTexel)).r;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float self = cellAt(uv, vec2(0.0, 0.0));

  float n = 0.0;
  n += cellAt(uv, vec2(-1.0, -1.0));
  n += cellAt(uv, vec2( 0.0, -1.0));
  n += cellAt(uv, vec2( 1.0, -1.0));
  n += cellAt(uv, vec2(-1.0,  0.0));
  n += cellAt(uv, vec2( 1.0,  0.0));
  n += cellAt(uv, vec2(-1.0,  1.0));
  n += cellAt(uv, vec2( 0.0,  1.0));
  n += cellAt(uv, vec2( 1.0,  1.0));

  // B3/S23. Compared with a tolerance rather than == because the state is a
  // float texture: exact integer equality on accumulated floats is the classic
  // way for a cellular automaton to develop mysterious dead patches.
  bool alive = self > 0.5;
  bool born = !alive && abs(n - 3.0) < 0.5;
  bool survives = alive && (abs(n - 2.0) < 0.5 || abs(n - 3.0) < 0.5);
  float next = (born || survives) ? 1.0 : 0.0;

  // Green channel is cell age, used only for shading. Held in the same texture
  // to avoid a second target: it rises while a cell lives and resets on death,
  // so long-lived still lifes read differently from churning frontiers.
  float age = texture(uState, uv).g;
  float nextAge = next > 0.5 ? min(age + 0.02, 1.0) : 0.0;

  // Blue channel remembers how recently a cell died, so the display pass can
  // fade deaths out over a few generations instead of hard-flickering them off.
  float decay = texture(uState, uv).b;
  float nextDecay = (alive && next < 0.5) ? 1.0 : max(decay - 0.18, 0.0);

  fragColor = vec4(next, nextAge, nextDecay, 1.0);
}
`

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uResolution;
uniform vec2 uGrid;
uniform vec3 uPhase;
uniform float uLumaScale;
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 s = texture(uState, uv);

  // Cell-local coordinate, used to inset each cell slightly. Without this the
  // grid reads as a solid sheet of colour at wall distance; the gaps are what
  // make it legible as cells.
  vec2 cell = fract(uv * uGrid);
  vec2 d = abs(cell - 0.5);
  float inset = 1.0 - smoothstep(0.34, 0.5, max(d.x, d.y));

  // Age drives the hue so that stable structures and active frontiers separate
  // visually -- a uniform colour makes the whole board read as noise.
  vec3 live = palettePerceptual(0.1 + s.g * 0.5, uPhase);
  vec3 dying = palettePerceptual(0.78, uPhase);

  // Live cells at full luminance, recent deaths as a fading ghost.
  vec3 col = live * s.r + dying * s.b * 0.45 * (1.0 - s.r);
  col *= inset;

  // Background is a dim tint rather than black. Per issue #88 the projector
  // wall sits in ambient light, and a dark-on-black board loses its structure
  // entirely at 12% washout.
  vec3 bg = palettePerceptual(0.72, uPhase) * 0.05;
  col = mix(bg, col, clamp(s.r + s.b * 0.6, 0.0, 1.0) * inset);

  // Live cells want real luminance headroom on a big display (issue #88).
  col *= uLumaScale;

  fragColor = vec4(col, 1.0);
}
`

export default {
  name: 'Game of Life',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, display = null, pp = null
    let gridW = 256, gridH = 128

    // RNG built in create(), not start(), so the look survives a start/stop
    // cycle -- the module contract in registry.js.
    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // 25-35% gives the liveliest early evolution; sparser fizzles out, denser
    // collapses to soup and then to still lifes almost immediately.
    let density = rng.range(0.25, 0.35)
    const cellPx = rng.range(TARGET_CELL_PX - 1, TARGET_CELL_PX + 2)

    // Simulation timing and stagnation state.
    let stepAccumulator = 0
    let lastTime = 0
    let popHistory = []
    let sinceReseed = 0

    /** Random soup at the given density, with a few gliders for early motion. */
    function makeSeedData(w, h, dens) {
      const data = new Float32Array(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = rng.next() < dens ? 1 : 0
      }
      // A handful of gliders. They travel across the board immediately, which
      // gives visible directed motion in the first seconds while the random
      // soup is still settling into its chaotic phase.
      const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]
      for (let g = 0; g < 6; g++) {
        const ox = rng.int(2, w - 4)
        const oy = rng.int(2, h - 4)
        for (const [dx, dy] of glider) {
          const x = (ox + dx) % w
          const y = (oy + dy) % h
          data[(y * w + x) * 4] = 1
        }
      }
      return data
    }

    /** Replace the board with a fresh soup. */
    function reseed() {
      density = rng.range(0.25, 0.35)
      const data = makeSeedData(gridW, gridH, density)
      gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, data)
      gl.bindTexture(gl.TEXTURE_2D, null)
      sinceReseed = 0
      popHistory = []
    }

    /**
     * Live fraction of the board, read back from the GPU.
     *
     * This stalls the pipeline, so it runs once every POPULATION_SAMPLE_EVERY
     * generations rather than continuously. Sampling a fixed subregion rather
     * than the whole grid keeps the transfer small; the population ratio of a
     * representative patch tracks the whole board closely enough to detect
     * "nothing is changing any more", which is all it is used for.
     */
    function samplePopulation() {
      const w = Math.min(gridW, 128)
      const h = Math.min(gridH, 128)
      const buf = new Float32Array(w * h * 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.read.fbo)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      let live = 0
      for (let i = 0; i < buf.length; i += 4) if (buf[i] > 0.5) live++
      return live / (w * h)
    }

    /**
     * True when the board has stopped producing new structure.
     *
     * Uses a band over a window rather than equality between consecutive
     * generations, because a period-2 oscillator holds population constant
     * while flickering forever -- consecutive-equality would fire on it
     * instantly, and plain inequality would never fire.
     */
    function isStagnant(pop) {
      popHistory.push(pop)
      if (popHistory.length > STAGNATION_WINDOW / POPULATION_SAMPLE_EVERY) {
        popHistory.shift()
      }
      if (popHistory.length < STAGNATION_WINDOW / POPULATION_SAMPLE_EVERY) return false
      // Everything alive died: nothing will ever happen again.
      if (pop <= 0.0001) return true
      const min = Math.min(...popHistory)
      const max = Math.max(...popHistory)
      return (max - min) < STAGNATION_BAND
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')

        gridW = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(canvas.width / cellPx)))
        gridH = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(canvas.height / cellPx)))

        pp = createPingPong(gl, gridW, gridH, makeSeedData(gridW, gridH, density))
        sim = createFullscreenPass(gl, SIM_FRAG)
        display = createFullscreenPass(gl, DISPLAY_FRAG)
        const uSim = createUniformCache(gl, sim.program)
        const uDisplay = createUniformCache(gl, display.program)
        const lumaScale = luminanceScale(canvas)

        stepAccumulator = 0
        lastTime = 0
        popHistory = []
        sinceReseed = 0

        runtime.start((time) => {
          // Elapsed time drives the generation count, so the simulation runs at
          // GENERATIONS_PER_SEC regardless of display refresh rate.
          const dt = lastTime === 0 ? 0 : Math.min(time - lastTime, 0.25)
          lastTime = time
          stepAccumulator += dt * GENERATIONS_PER_SEC

          // Cap the catch-up burst. After a tab stall or a long frame this
          // would otherwise try to run hundreds of generations in one frame and
          // visibly hitch.
          let steps = Math.min(Math.floor(stepAccumulator), 4)
          stepAccumulator -= steps

          while (steps-- > 0) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
            gl.viewport(0, 0, gridW, gridH)
            sim.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, pp.read.tex)
              // NEAREST for the simulation read. Life counts exact neighbours;
              // an interpolated sample would return fractional neighbour counts
              // and the B3/S23 test would decay into mush. The display pass
              // sets LINEAR on this same texture, so each pass must assert the
              // filter it needs.
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
              g.uniform1i(uSim('uState'), 0)
              g.uniform2f(uSim('uTexel'), 1 / gridW, 1 / gridH)
            })
            pp.swap()
            // Generations since the last reseed: drives both the stagnation
            // window and the MAX_GENERATIONS backstop.
            sinceReseed++

            if (sinceReseed % POPULATION_SAMPLE_EVERY === 0) {
              if (isStagnant(samplePopulation()) || sinceReseed >= MAX_GENERATIONS) {
                reseed()
              }
            }
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            // NEAREST for display too, unlike reaction-diffusion. Life's cells
            // are discrete and the grid *is* the image: interpolating them
            // would smear neighbouring cells together and destroy the crisp
            // structure that makes gliders and still lifes recognisable.
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
            g.uniform1i(uDisplay('uState'), 0)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform2f(uDisplay('uGrid'), gridW, gridH)
            g.uniform3f(uDisplay('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(uDisplay('uLumaScale'), lumaScale)
          })
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (display) { display.destroy(); display = null }
        if (pp) { pp.destroy(); pp = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
