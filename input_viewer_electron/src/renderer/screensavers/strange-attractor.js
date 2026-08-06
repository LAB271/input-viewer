// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Strange Attractor — a Clifford attractor plotted from many thousands of
 * points. Each point iterates the map every frame; points are drawn additively
 * over a slowly-fading buffer, building up the glowing filamentary structure.
 * The attractor parameters drift over time so the shape continuously morphs.
 *
 * Clifford attractor:
 *   x' = sin(a*y) + c*cos(a*x)
 *   y' = sin(b*x) + d*cos(b*y)
 *
 * Per-activation variation: the parameter centres, drift amplitudes, drift
 * rates and phases are all randomised, plus the palette.
 *
 * This saver needed it most. The random seed positions were near-useless on
 * their own: the Clifford map is a strong contraction, so every point converges
 * onto the same attracting set within a handful of iterations. With a,b,c,d
 * being pure functions of a time that always started at 0, the accumulated
 * image after the first second was identical on every activation -- the seed
 * bought about one second of differing transient smear and nothing after.
 * Randomising the *parameters* is what actually changes the shape.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide, luminanceScale, fadeAlphaForHalfLife } from './gl-base.js'
import { createRng } from './seed.js'

const SIDE = 256 // 65,536 points
// Scales up with canvas area; capped to bound worst-case GPU cost,
// so very large displays go slightly sparser rather than very expensive.
const MAX_SIDE = 384

// Parameter regions that produce a well-formed Clifford attractor: filamentary,
// filling a good part of its bounding box, neither collapsing to a point/ring
// nor diverging. Picked from a sweep rather than sampled blind -- most of
// (a,b,c,d) space gives something degenerate, so a curated set is what keeps
// every activation worth looking at.
const FAMILIES = [
  { a: -1.40, b: 1.60, c: 1.00, d: 0.70 }, // the original
  { a: -1.70, b: 1.80, c: 1.90, d: 0.40 },
  { a: -1.80, b: -2.00, c: -0.50, d: -0.90 },
  { a: 1.60, b: -0.60, c: -1.20, d: 1.60 },
  { a: -1.10, b: 1.90, c: 1.50, d: 0.60 },
  { a: 1.50, b: -1.80, c: 1.60, d: 0.90 },
  { a: -1.35, b: -1.75, c: 1.20, d: -1.10 }
]

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;  // xy = point position
uniform vec2 uTexel;
uniform vec4 uParams;      // a, b, c, d
out vec4 outState;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 p = texture(uState, uv).xy;
  float a = uParams.x, b = uParams.y, c = uParams.z, d = uParams.w;
  vec2 np = vec2(
    sin(a * p.y) + c * cos(a * p.x),
    sin(b * p.x) + d * cos(b * p.y)
  );
  outState = vec4(np, 0.0, 1.0);
}`

const DRAW_VERT = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uSide;
uniform float uScale;
out float vIdx;
void main() {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / uSide;
  vec2 p = texture(uState, uv).xy;
  // Clifford output is within roughly [-3,3]; scale to clip space.
  gl_Position = vec4(p / 3.0, 0.0, 1.0);
  gl_PointSize = 1.0 * uScale;
  vIdx = float(id) / (uSide * uSide);
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
in float vIdx;
uniform float uTime;
uniform float uLum;
uniform vec3 uPhase;
out vec4 outColor;
void main() {
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (vIdx * 0.5 + uTime * 0.03 + uPhase));
  // Dim + additive accumulation: brightness comes from many overlapping points
  // rather than any single one. uLum lifts it on big-room displays, where
  // ambient light raises the black floor this effect depends on (see #88).
  // Boosts the colour rather than the alpha, so the accumulation still builds
  // up gradually instead of the points turning opaque.
  outColor = vec4(min(col * 0.5 * uLum, vec3(1.0)), 0.12);
}`

// Trail fade. The alpha is supplied per frame rather than baked in, so trail
// length is wall-clock instead of frame-count -- a constant per-frame alpha
// makes trails half as long at 120Hz as at 60Hz (issue #113).
const FADE_FRAG = `#version 300 es
precision highp float;
uniform float uFadeAlpha;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFadeAlpha); }`

// Chosen to reproduce the previous look at 60Hz, where the fixed 0.04 alpha
// decayed a trail to half brightness in ~0.28s.
const TRAIL_HALF_LIFE_S = 0.283

export default {
  name: 'Strange Attractor',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, vao = null
    // Resolved in start(), once createGLRuntime has sized the canvas: the
    // particle count scales with canvas area, so it cannot be known here.
    let side = SIDE
    let COUNT = side * side

    const rng = createRng(seedValue)
    const family = rng.pick(FAMILIES)
    const phase = [rng.next(), rng.next() + 0.33, rng.next() + 0.67]
    // Each parameter gets its own drift amplitude, rate and phase, so the shape
    // morphs along a different trajectory through parameter space every run.
    // Amplitudes stay modest: the curated family centres are what keep the
    // attractor well-formed, and a large excursion wanders out of that region.
    const drift = ['a', 'b', 'c', 'd'].map(() => ({
      amp: rng.range(0.18, 0.42),
      rate: rng.range(0.025, 0.075),
      phase: rng.phase()
    }))

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        data[i * 4 + 0] = rng.range(-2, 2)
        data[i * 4 + 1] = rng.range(-2, 2)
        data[i * 4 + 3] = 1.0
      }
      return data
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        // createGLRuntime has now sized the canvas, so area-based scaling is
        // valid. Must precede seed(), which allocates COUNT particles.
        side = particleSide(canvas, SIDE, MAX_SIDE)
        COUNT = side * side
        pp = createPingPong(gl, side, side, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        fade = createFullscreenPass(gl, FADE_FRAG)
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        vao = gl.createVertexArray()

        // Clear to black once.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)

        runtime.start((time, frameCount, glCtx, rt) => {
          // Slowly morphing Clifford parameters, drifting around this
          // activation's family centre with per-parameter rate and phase.
          const a = family.a + drift[0].amp * Math.sin(time * drift[0].rate + drift[0].phase)
          const b = family.b + drift[1].amp * Math.sin(time * drift[1].rate + drift[1].phase)
          const c = family.c + drift[2].amp * Math.sin(time * drift[2].rate + drift[2].phase)
          const d = family.d + drift[3].amp * Math.sin(time * drift[3].rate + drift[3].phase)

          // Advance the points.
          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, side, side)
          sim.draw((g, p) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(g.getUniformLocation(p, 'uState'), 0)
            g.uniform2f(g.getUniformLocation(p, 'uTexel'), 1 / side, 1 / side)
            g.uniform4f(g.getUniformLocation(p, 'uParams'), a, b, c, d)
          })
          pp.swap()

          // Fade prior frame, then accumulate points additively.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          fade.draw((g, p) => {
            g.uniform1f(g.getUniformLocation(p, 'uFadeAlpha'),
              fadeAlphaForHalfLife(rt.dt, TRAIL_HALF_LIFE_S))
          })
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
          gl.useProgram(drawProg.program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(gl.getUniformLocation(drawProg.program, 'uState'), 0)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uSide'), side)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uTime'), time)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uScale'), pointScale(canvas, 1.0))
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uLum'), luminanceScale(canvas))
          gl.uniform3f(gl.getUniformLocation(drawProg.program, 'uPhase'), phase[0], phase[1], phase[2])
          gl.drawArrays(gl.POINTS, 0, COUNT)
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (fade) { fade.destroy(); fade = null }
        if (drawProg) { drawProg.destroy(); drawProg = null }
        if (vao) { gl.deleteVertexArray(vao); vao = null }
        if (pp) { pp.destroy(); pp = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
