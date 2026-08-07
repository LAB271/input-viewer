// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Particle Swarm — tens of thousands of particles carried through a slowly
 * evolving curl-noise field, leaving luminous trails on black.
 *
 * Rewritten. The previous version had three problems, all of which showed:
 *
 *   - It was the only saver on a *white* background (multiply blend, "ink on
 *     paper"). On the no-signal videowall that meant every other saver is dark
 *     and this one flooded the room with a full-screen field of light.
 *   - Motion came from two inverse-square attractors, so particles slingshotted
 *     violently past them, and `mod()` wrapping teleported them across the
 *     screen mid-flight. The result read as chaotic rather than graceful.
 *   - Being multiply-on-white, it could not use the HDR/bloom chain the other
 *     particle savers gained (#112, #113), so it was stuck at 8-bit.
 *
 * Now: divergence-free curl noise (shared library, #115) advects the particles.
 * Because the field is divergence-free they neither bunch into knots nor spread
 * out — they follow coherent streams that braid and separate. Instead of
 * wrapping, particles respawn on a lifetime, fading in and out so there is no
 * teleport. Drawn additively on black through the post chain, so dense braids
 * bloom and the trails accumulate in HDR.
 *
 * Per-activation variation: where in the noise field this run samples, the
 * field scale, flow speed, evolution rate, lifetime spread and palette phase.
 * The spatial offset matters most — the field is sampled at the particle's own
 * position, so without it every activation falls into the same eddies.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide, luminanceScale, fadeAlphaForHalfLife } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

const PARTICLES_SIDE = 256 // 256x256 = 65,536 particles
// Scales up with canvas area; capped to bound worst-case GPU cost,
// so very large displays go slightly sparser rather than very expensive.
const MAX_SIDE = 384

// Trail half-life. Long enough that a stream draws the shape of the flow,
// short enough that the frame does not saturate: trails accumulate to roughly
// 1/(1-keepPerFrame), so 0.55s meant a ~48x steady-state build-up and the
// whole screen washed out. 0.18s is ~16x, which reads as a trail rather than
// a fog.
const TRAIL_HALF_LIFE_S = 0.18

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;   // xy = pos [-1,1], z = seed phase, w = life
uniform vec2 uTexel;
uniform float uTime;
uniform float uDt;
uniform vec2 uFieldOffset;  // where in the noise field this activation samples
uniform float uFieldScale;
uniform float uFlowSpeed;
uniform float uEvolve;      // how fast the field itself churns
uniform float uLifeSpan;
out vec4 outState;

${GLSL.hash}
${GLSL.simplex2d}
${GLSL.curl2d}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  vec2 pos = s.xy;
  float phase = s.z;
  float life = s.w;

  // Divergence-free advection: particles are carried by the field rather than
  // pulled toward point attractors, so they form streams instead of slingshots.
  vec2 v = curl2d(pos * uFieldScale + uFieldOffset, uTime * uEvolve);
  pos += v * uDt * uFlowSpeed;
  life -= uDt / uLifeSpan;

  // Respawn on lifetime rather than wrapping at the edges. mod() wrapping
  // teleported particles across the screen mid-stream, which was the single
  // most jarring thing about the old motion.
  if (life <= 0.0 || abs(pos.x) > 1.1 || abs(pos.y) > 1.1) {
    vec2 r = rand2(uv + vec2(uTime, -uTime));
    pos = r * 2.0 - 1.0;
    life = 0.6 + rand(uv * 3.1 + uTime) * 0.8;
    phase = rand(uv * 5.3 + uTime);
  }

  outState = vec4(pos, phase, life);
}`

const DRAW_VERT = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uSide;
uniform float uScale;
uniform float uFieldScale;
uniform float uFieldOffsetX;
uniform float uFieldOffsetY;
uniform float uTime;
uniform float uEvolve;
out float vSpeed;
out float vAlpha;
out float vPhase;

${GLSL.simplex2d}
${GLSL.curl2d}

void main() {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / uSide;
  vec4 s = texture(uState, uv);

  // Speed drives colour, so the fast filaments read hotter than the slow
  // eddies -- that is what makes the flow structure legible.
  vec2 v = curl2d(s.xy * uFieldScale + vec2(uFieldOffsetX, uFieldOffsetY), uTime * uEvolve);
  vSpeed = length(v);
  vPhase = s.z;

  // Fade in and out over the lifetime so respawns are invisible.
  vAlpha = smoothstep(0.0, 0.15, s.w) * smoothstep(1.4, 0.5, s.w);

  gl_Position = vec4(s.xy, 0.0, 1.0);
  gl_PointSize = 1.5 * uScale;
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
${GLSL.palette}
in float vSpeed;
in float vAlpha;
in float vPhase;
uniform vec3 uPhase;
uniform float uLum;
out vec4 outColor;
void main() {
  // Round, soft-edged sprite. GL_POINTS defaults to a hard axis-aligned square,
  // which on the wall means visible blocks at pointScale's 4px floor (#116).
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float soft = smoothstep(0.25, 0.0, r2);

  // Colour by speed, with a small per-particle offset so a stream is not one
  // flat hue. Normalised through tanh so the palette does not saturate the
  // moment the field happens to be energetic.
  float t = tanh(vSpeed * 0.35) + vPhase * 0.12;
  vec3 col = palettePerceptual(t, uPhase);

  // Additive on black, no clamp: the post chain tonemaps, so dense braids
  // carry real information above 1.0 instead of clipping to white.
  outColor = vec4(col * vAlpha * soft * 0.10 * uLum, 1.0);
}`

// Trail fade, alpha supplied per frame so trail length is wall-clock rather
// than frame-count (issue #113).
const FADE_FRAG = `#version 300 es
precision highp float;
uniform float uFadeAlpha;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFadeAlpha); }`

export default {
  name: 'Particle Swarm',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, vao = null
    let post = null
    // Resolved in start(), once createGLRuntime has sized the canvas.
    let SIDE = PARTICLES_SIDE
    let COUNT = SIDE * SIDE

    // Drawn here rather than in start() so a start/stop/start cycle keeps the
    // same look; only a fresh create() picks a new one.
    const rng = createRng(seedValue)
    // The load-bearing one. The field is sampled at the particle's own
    // position, so without a spatial offset every activation falls into the
    // same eddies in the same places. A time offset would not fix that: it
    // only slides the same pattern past.
    const fieldOffset = [rng.range(0, 64), rng.range(0, 64)]
    // Lower is broad lazy sweeps, higher is a busier braided field. Both read
    // as coherent flow, which is the point.
    const fieldScale = rng.range(0.9, 1.8)
    const flowSpeed = rng.range(0.08, 0.16)
    // How fast the field itself churns, independent of how fast particles move
    // through it. Slow: the structure should feel like it is breathing.
    const evolve = rng.range(0.04, 0.11)
    const lifeSpan = rng.range(3.5, 7.0)
    const phase = [rng.next(), rng.next() + 0.33, rng.next() + 0.67]

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        data[i * 4 + 0] = rng.range(-1, 1)
        data[i * 4 + 1] = rng.range(-1, 1)
        data[i * 4 + 2] = rng.next()                 // per-particle phase
        data[i * 4 + 3] = 0.3 + rng.next() * 1.1     // life, staggered
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
        SIDE = particleSide(canvas, PARTICLES_SIDE, MAX_SIDE)
        COUNT = SIDE * SIDE
        pp = createPingPong(gl, SIDE, SIDE, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        fade = createFullscreenPass(gl, FADE_FRAG)
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        vao = gl.createVertexArray()
        // Uniform locations are fixed for a program's lifetime; looking them up
        // inside the per-frame draw callback was a string-keyed driver query
        // every frame for values that never move (issue #115).
        const uSim = createUniformCache(gl, sim.program)
        const uFade = createUniformCache(gl, fade.program)
        const uDraw = createUniformCache(gl, drawProg.program)

        // HDR accumulation + bloom (issues #112, #113), which the old
        // multiply-on-white version could not use at all. Threshold sits above
        // a single particle so only dense braids glow.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 1.0 * luminanceScale(canvas),
            knee: 0.4,
            intensity: 0.3,
            radius: 0.9
          },
          tonemap: 'aces',
          dither: true
        })

        gl.bindFramebuffer(gl.FRAMEBUFFER, post ? post.sceneTarget.fbo : null)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)

        runtime.start((time, frameCount, glCtx, rt) => {
          const dt = rt.dt

          // Sim pass.
          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, SIDE, SIDE)
          sim.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(uSim('uState'), 0)
            g.uniform2f(uSim('uTexel'), 1 / SIDE, 1 / SIDE)
            g.uniform1f(uSim('uTime'), time)
            g.uniform1f(uSim('uDt'), dt)
            g.uniform2f(uSim('uFieldOffset'), fieldOffset[0], fieldOffset[1])
            g.uniform1f(uSim('uFieldScale'), fieldScale)
            g.uniform1f(uSim('uFlowSpeed'), flowSpeed)
            g.uniform1f(uSim('uEvolve'), evolve)
            g.uniform1f(uSim('uLifeSpan'), lifeSpan)
          })
          pp.swap()

          // Fade the previous frame, then accumulate particles additively.
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          fade.draw((g) => {
            g.uniform1f(uFade('uFadeAlpha'),
              fadeAlphaForHalfLife(dt, TRAIL_HALF_LIFE_S))
          })

          gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
          gl.useProgram(drawProg.program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(uDraw('uState'), 0)
          gl.uniform1f(uDraw('uSide'), SIDE)
          gl.uniform1f(uDraw('uScale'), pointScale(canvas, 1.5))
          gl.uniform1f(uDraw('uFieldScale'), fieldScale)
          gl.uniform1f(uDraw('uFieldOffsetX'), fieldOffset[0])
          gl.uniform1f(uDraw('uFieldOffsetY'), fieldOffset[1])
          gl.uniform1f(uDraw('uTime'), time)
          gl.uniform1f(uDraw('uEvolve'), evolve)
          gl.uniform1f(uDraw('uLum'), luminanceScale(canvas))
          gl.uniform3f(uDraw('uPhase'), phase[0], phase[1], phase[2])
          gl.drawArrays(gl.POINTS, 0, COUNT)

          if (post) post.present()
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (fade) { fade.destroy(); fade = null }
        if (drawProg) { drawProg.destroy(); drawProg = null }
        if (vao) { gl.deleteVertexArray(vao); vao = null }
        if (pp) { pp.destroy(); pp = null }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
