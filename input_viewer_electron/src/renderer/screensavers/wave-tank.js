// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Wave tank — a 2D damped wave equation over the surface, with drops
 * perturbing it so ripples spread, reflect and interfere (#96).
 *
 * Structurally the same shape as reaction-diffusion.js: a ping-pong float
 * texture with a stencil update per step. That machinery is known to work, so
 * this is mostly a shader swap.
 *
 * Two details from #96 are load-bearing:
 *
 * 1. **Shade by slope, not by height.** Sampling the horizontal derivative and
 *    using it as a lighting term is what makes this read as a water surface.
 *    Colouring by amplitude alone looks like a false-colour heightmap.
 *
 * 2. **Damping just under 1.** Too low and ripples die before they interfere;
 *    at or above 1 the scheme is unstable and the surface blows up. 0.978 is
 *    the prototype's value and holds.
 *
 * Boundaries are reflective walls -- the update only touches interior cells, so
 * ripples bounce off the frame. #96 offers a borderless variant via REPEAT
 * wrapping, but "tank with walls" is both the easier option and the better
 * looking one, so it is the deliberate choice rather than an accident of
 * createFloatTarget hardcoding CLAMP_TO_EDGE.
 *
 * Per-activation variation: drop cadence and size, damping within its stable
 * band, wave speed and palette.
 */
import {
  createGLRuntime,
  createFullscreenPass,
  createPingPong,
  luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Simulation cells per device pixel. The wave equation does not need per-pixel
// resolution -- ripples are many cells wide -- and cost is per cell, so a
// quarter-resolution grid looks identical for a sixteenth of the work.
const CELL_PX = 4
const MAX_CELLS = 1024
const MIN_CELLS = 64

// Simulation steps per frame. More than one makes ripples travel at a
// believable speed without raising the grid resolution.
const STEPS_PER_FRAME = 2

const SIM_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;   // r = current height, g = previous height
uniform vec2 uTexel;
uniform float uDamping;
uniform vec3 uDrop;         // xy = position (0..1), z = radius in texels; z<=0 for none
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;

  // Reflective walls: the update only touches interior cells, so the boundary
  // holds its value and ripples bounce. This is the "tank" look #96 prefers.
  bool edge = uv.x < uTexel.x * 1.5 || uv.x > 1.0 - uTexel.x * 1.5 ||
              uv.y < uTexel.y * 1.5 || uv.y > 1.0 - uTexel.y * 1.5;
  if (edge) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float here = texture(uState, uv).r;
  float prev = texture(uState, uv).g;

  float n = texture(uState, uv + vec2(0.0, uTexel.y)).r
          + texture(uState, uv - vec2(0.0, uTexel.y)).r
          + texture(uState, uv + vec2(uTexel.x, 0.0)).r
          + texture(uState, uv - vec2(uTexel.x, 0.0)).r;

  // Discrete wave step. The neighbourSum/2 - prev form is the standard
  // second-order scheme; damping must stay below 1 or it is unstable.
  float next = (n * 0.5 - prev) * uDamping;

  // Drops. Added after the step so a drop is a genuine displacement rather than
  // something the wave equation immediately averages away.
  if (uDrop.z > 0.0) {
    float d = length((uv - uDrop.xy) / uTexel);
    if (d < uDrop.z) {
      // Cosine profile: a hard disc injects high frequencies the grid cannot
      // represent, which shows up as square artefacts spreading from the drop.
      next -= cos(d / uDrop.z * 1.5707963) * 0.6;
    }
  }

  fragColor = vec4(next, here, 0.0, 1.0);
}
`

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform vec3 uPhase;
uniform float uLumaScale;
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Slope, not height. This is the detail that makes the surface read as lit
  // water: colouring by amplitude alone gives a false-colour heightmap, because
  // a real surface is visible through how it redirects light, not how high it
  // sits. Central differences give the gradient.
  float hx = texture(uState, uv + vec2(uTexel.x, 0.0)).r
           - texture(uState, uv - vec2(uTexel.x, 0.0)).r;
  float hy = texture(uState, uv + vec2(0.0, uTexel.y)).r
           - texture(uState, uv - vec2(0.0, uTexel.y)).r;

  // Treat the gradient as a surface normal and light it from one side.
  vec3 normal = normalize(vec3(-hx * 12.0, -hy * 12.0, 1.0));
  vec3 lightDir = normalize(vec3(-0.55, 0.6, 0.58));
  float diffuse = max(dot(normal, lightDir), 0.0);

  // Specular gives the bright crests that make interference legible at a
  // distance -- the diffuse term alone is too soft to read across a room.
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(lightDir + viewDir);
  float spec = pow(max(dot(normal, halfway), 0.0), 42.0);

  float height = texture(uState, uv).r;

  // Deep water below, brighter where the surface tilts toward the light. Hue
  // shifts a little with height so troughs and crests are distinguishable
  // beyond the lighting alone.
  vec3 deep = palettePerceptual(0.62 + uPhase.x, uPhase) * 0.10;
  vec3 lit = palettePerceptual(0.45 + uPhase.x + height * 0.12, uPhase);

  vec3 col = deep + lit * diffuse * 0.55 + vec3(0.9, 0.95, 1.0) * spec * 0.55;
  col *= uLumaScale;

  fragColor = vec4(col, 1.0);
}
`

export default {
  name: 'Wave Tank',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, display = null, pp = null
    let simW = 256, simH = 128

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // Damping inside its stable band. Below about 0.97 ripples die before they
    // meet; at 1.0 or above the scheme gains energy and the surface explodes.
    const damping = rng.range(0.972, 0.984)
    // Seconds between drops, and how much that varies.
    const dropInterval = rng.range(0.55, 1.4)

    let nextDrop = 0
    let elapsed = 0
    let lastTime = 0

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')

        simW = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(canvas.width / CELL_PX)))
        simH = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(canvas.height / CELL_PX)))

        // Starts flat; the first drop arrives within a second.
        pp = createPingPong(gl, simW, simH, new Float32Array(simW * simH * 4))
        sim = createFullscreenPass(gl, SIM_FRAG)
        display = createFullscreenPass(gl, DISPLAY_FRAG)
        const uSim = createUniformCache(gl, sim.program)
        const uDisplay = createUniformCache(gl, display.program)
        const lumaScale = luminanceScale(canvas)

        elapsed = 0
        nextDrop = 0.2
        lastTime = 0

        runtime.start((time) => {
          const dt = lastTime === 0 ? 0.016 : Math.min(time - lastTime, 0.1)
          lastTime = time
          elapsed += dt

          // At most one drop per frame; a queue would let a stall dump several
          // at once, which reads as a splash rather than rain.
          let drop = [0, 0, 0]
          if (elapsed >= nextDrop) {
            nextDrop = elapsed + dropInterval * rng.range(0.6, 1.5)
            // Kept away from the walls so a drop is not half-absorbed by the
            // reflective boundary the instant it forms.
            drop = [
              rng.range(0.12, 0.88),
              rng.range(0.12, 0.88),
              // Occasional larger drops, per #96, for variety.
              rng.chance(0.18) ? rng.range(7, 12) : rng.range(2.5, 5)
            ]
          }

          for (let i = 0; i < STEPS_PER_FRAME; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
            gl.viewport(0, 0, simW, simH)
            sim.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, pp.read.tex)
              // NEAREST for the simulation: the stencil reads exact
              // neighbouring cells, and interpolating them would smear the
              // wave. The display pass sets LINEAR on this same texture, so
              // each pass must assert the filter it needs.
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
              g.uniform1i(uSim('uState'), 0)
              g.uniform2f(uSim('uTexel'), 1 / simW, 1 / simH)
              g.uniform1f(uSim('uDamping'), damping)
              // Only the first substep injects the drop, or one drop would be
              // added twice per frame at double strength.
              const d = i === 0 ? drop : [0, 0, 0]
              g.uniform3f(uSim('uDrop'), d[0], d[1], d[2])
            })
            pp.swap()
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            // LINEAR for display only: the grid is coarser than the canvas, so
            // NEAREST would show hard cell blocks on the wall (#114).
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
            g.uniform1i(uDisplay('uState'), 0)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform2f(uDisplay('uTexel'), 1 / simW, 1 / simH)
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
