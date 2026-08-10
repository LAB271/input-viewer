// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Boids — emergent flocking. Each boid applies separation, alignment and
 * cohesion against a sampled subset of the flock (read from the state
 * texture), producing the classic murmuration motion. Drawn as additive
 * points over a softly-faded background for trails.
 *
 * Flock size is kept modest (a few thousand) because each boid samples many
 * others per frame; that is plenty for a convincing screensaver.
 *
 * Per-activation variation: the three flocking weights, both neighbourhood
 * radii, the centre pull, the speed limits and the palette phase are perturbed.
 *
 * Unlike most of the savers, this one already had genuine per-run variation --
 * the neighbour sampling is stochastic and the initial positions random, so the
 * murmuration never traced the same path twice. What it lacked was variation in
 * *character*: with the weights fixed, every activation settled into the same
 * flock temperament, a single tight fast-turning swarm. Moving the weights and
 * radii is what gives one run loose scattered bands and the next a dense
 * hurrying knot. The bounds below are more than cosmetic: separation must stay
 * inside the alignment radius and the minimum speed below the maximum, or the
 * flocking degenerates into a jitter or a frozen lattice.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide, fadeAlphaForHalfLife, luminanceScale } from './gl-base.js'
import { GLSL, createInstancedQuads, createUniformCache, canvasAspect } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

const SIDE = 64 // 64x64 = 4096 boids
// Scales up with canvas area; capped to bound worst-case GPU cost, so very
// large displays go slightly sparser rather than very expensive.
//
// The cap is much lower than the plain particle screensavers' (384) because
// each boid samples SAMPLES neighbours per frame, making cost COUNT * SAMPLES
// rather than COUNT. At 128 the wall runs ~14k boids => ~0.46M neighbour
// tests/frame, against ~0.13M at 1080p; uncapped it would be ~0.90M.
const MAX_SIDE = 128
const SAMPLES = 32 // neighbors sampled per boid per frame

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;  // xy=pos [-1,1], zw=vel
uniform vec2 uTexel;
uniform float uDt;
uniform float uFrame;
uniform vec2 uRadii;    // x = separation radius, y = alignment/cohesion radius
uniform vec3 uWeights;  // separation, alignment, cohesion
uniform float uCenter;  // pull toward the origin
uniform vec2 uSpeed;    // x = max, y = min
uniform float uAspect;  // width / height, for world-space extent
out vec4 outState;

${GLSL.worldSpace}

const int SAMPLES = ${SAMPLES};

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 ext = worldExtent(uAspect);
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  vec2 pos = s.xy;
  vec2 vel = s.zw;

  vec2 sep = vec2(0.0);
  vec2 ali = vec2(0.0);
  vec2 coh = vec2(0.0);
  float count = 0.0;

  float seed = uv.x * 71.0 + uv.y * 113.0 + uFrame * 0.013;
  for (int i = 0; i < SAMPLES; i++) {
    vec2 r = vec2(rand(vec2(seed, float(i))), rand(vec2(float(i), seed)));
    vec4 o = texture(uState, r);
    // Toroidal separation: a plain (o.xy - pos) makes neighbours just across
    // the wrap seam read as maximally distant, which is what made the flock
    // visibly tear at screen edges (issue #114).
    vec2 d = torusDelta(pos, o.xy, ext);
    float dist = length(d);
    if (dist < 0.0001) continue;
    if (dist < uRadii.x) sep -= d / dist * (uRadii.x - dist);
    if (dist < uRadii.y) {
      ali += o.zw;
      // Accumulate the neighbour's position *relative to this boid*, so
      // cohesion works across the seam too rather than dragging the flock
      // back toward the middle of the field.
      coh += d;
      count += 1.0;
    }
  }

  vec2 acc = sep * uWeights.x;
  if (count > 0.0) {
    ali /= count;
    coh /= count;
    acc += (ali - vel) * uWeights.y;
    acc += coh * uWeights.z;
  }
  // Gentle pull to center so the flock stays on-screen.
  acc += -pos * uCenter;

  vel += acc * uDt;
  float sp = length(vel);
  float maxSp = uSpeed.x;
  if (sp > maxSp) vel = vel / sp * maxSp;
  if (sp < uSpeed.y && sp > 0.0) vel = vel / sp * uSpeed.y;
  pos += vel * uDt;

  // Wrap in world space, so the field is uniform in both axes rather than
  // 5x wider than tall.
  pos = torusWrap(pos, ext);

  outState = vec4(pos, vel);
}`

// Instanced oriented quads rather than GL_POINTS (issue #116). A point sprite
// cannot be rotated, so this saver used to compute each boid's heading and then
// throw it away, using it only for hue -- a murmuration of round dots instead of
// arrowheads, which loses most of the read.
const DRAW_VERT = `#version 300 es
precision highp float;
uniform float uScale;
uniform vec2 uQuadScale; // pixel->clip conversion, keeps quads square
uniform float uAspect;   // width / height
out float vDir;
out vec2 vQuad;         // local quad coords in [-0.5, 0.5], for the arrow shape

${GLSL.instancedQuad}
${GLSL.worldSpace}

void main() {
  vec2 uv;
  vec4 s = fetchInstance(uv);
  vec2 vel = s.zw;
  vDir = atan(vel.y, vel.x);
  vQuad = aCorner;

  // Stretched along travel so the boid reads as an arrowhead with a heading,
  // not a blob. 2.5px was the old point size; the quad is sized to match.
  //
  // Rotate in PIXEL space, then convert to clip (issue #190). The size must
  // stay isotropic through orientedQuadOffset: uQuadScale is the pixel->clip
  // conversion and is therefore per-axis, so folding it in before the rotation
  // rotates an already-anisotropically-scaled corner, which shears the quad by
  // the display aspect -- 5x on the 6000x1200 wall, and invisible at 16:9,
  // which is how it survived. Pixel space is isotropic on screen because world
  // space maps to it by a uniform scale, so the heading is preserved.
  vec2 sizePx = vec2(2.5 * uScale);
  vec2 offsetPx = orientedQuadOffset(vel, sizePx, 2.2);
  // Positions are world space (issue #114); only this final step reintroduces
  // the display aspect, for the position and the quad offset alike.
  gl_Position = clipFromWorld(s.xy, uAspect) + vec4(offsetPx * uQuadScale, 0.0, 0.0);
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
${GLSL.palette}
in float vDir;
in vec2 vQuad;
uniform vec3 uPhase;
out vec4 outColor;
void main() {
  // Arrowhead: full width at the tail, tapering to a point at the nose. x runs
  // -0.5 (tail) to +0.5 (nose) along the direction of travel.
  float alongTravel = vQuad.x + 0.5;              // 0 at tail, 1 at nose
  float halfWidth = 0.5 * (1.0 - alongTravel);    // taper toward the nose
  if (abs(vQuad.y) > halfWidth) discard;

  // Soft edges so it does not alias, and brighter toward the nose so the
  // direction of travel is legible at a glance.
  float edge = smoothstep(halfWidth, halfWidth * 0.4, abs(vQuad.y));
  float nose = mix(0.55, 1.0, alongTravel);

  float hue = vDir / 6.2831 + 0.5;
  vec3 col = palettePerceptual(hue, uPhase);
  outColor = vec4(col * nose * edge, 0.9);
}`

// Trail fade. Alpha comes in per frame so trail length is wall-clock rather
// than frame-count (issue #113).
const FADE_FRAG = `#version 300 es
precision highp float;
uniform float uFadeAlpha;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFadeAlpha); }`

// Reproduces the previous look at 60Hz, where the fixed 0.08 alpha halved a
// trail's brightness in ~0.14s.
const TRAIL_HALF_LIFE_S = 0.139

export default {
  name: 'Boids',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, quads = null
    let post = null
    let frame = 0
    // Resolved in start(), once createGLRuntime has sized the canvas: the
    // particle count scales with canvas area, so it cannot be known here.
    let side = SIDE
    let COUNT = side * side
    // Resolved in start(), once createGLRuntime has sized the canvas.
    let aspect = 1

    // Drawn here rather than in start() so a start/stop/start cycle keeps the
    // same temperament; only a fresh create() picks a new one.
    const rng = createRng(seedValue)
    // The two radii are drawn from deliberately disjoint ranges rather than
    // perturbed independently, which is how separation is *guaranteed* to stay
    // strictly inside the alignment neighbourhood. If they cross, every
    // neighbour that pushes a boid away also pulls it in, the two forces cancel
    // and the flock stops flocking.
    const sepRadius = rng.range(0.045, 0.08)   // near the tuned 0.06
    const aliRadius = rng.range(0.14, 0.24)    // near the tuned 0.18
    // Separation must stay the dominant force or the flock collapses into a
    // single point; alignment and cohesion stay well under it.
    const weights = [rng.range(1.2, 1.9), rng.range(0.35, 0.7), rng.range(0.28, 0.55)]
    // Centre pull near 0.05: too little and the flock wanders off through the
    // wrap seam, too much and it becomes a ball pinned to the middle.
    const center = rng.range(0.035, 0.07)
    // Same disjoint-ranges trick as the radii: min must stay strictly below
    // max, or the two clamps fight and the velocity oscillates every frame.
    const maxSpeed = rng.range(0.4, 0.62)      // near the tuned 0.5
    const minSpeed = rng.range(0.1, 0.22)      // near the tuned 0.15
    const phase = [rng.next(), rng.next() + 0.33, rng.next() + 0.67]

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        const a = rng.angle()
        // World space: y spans [-0.5, 0.5] and x spans the aspect-scaled
        // width, so the flock fills the display rather than a square.
        data[i * 4 + 0] = rng.range(-0.5, 0.5) * aspect
        data[i * 4 + 1] = rng.range(-0.5, 0.5)
        data[i * 4 + 2] = Math.cos(a) * 0.3
        data[i * 4 + 3] = Math.sin(a) * 0.3
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
        aspect = canvasAspect(canvas)
        side = particleSide(canvas, SIDE, MAX_SIDE)
        COUNT = side * side
        pp = createPingPong(gl, side, side, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        fade = createFullscreenPass(gl, FADE_FRAG)
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        // Instanced unit quads, oriented per boid in the vertex shader.
        quads = createInstancedQuads(gl, drawProg.program)
        // Uniform locations are fixed for a program's lifetime; looking them up
        // inside the per-frame draw callback was a string-keyed driver query
        // every frame for values that never move (issue #115).
        const uSim = createUniformCache(gl, sim.program)
        const uFade = createUniformCache(gl, fade.program)
        const uDraw = createUniformCache(gl, drawProg.program)
        frame = 0

        // HDR accumulation + bloom/tonemap/dither (issues #112, #113). Falls
        // back to the 8-bit default framebuffer when float targets are absent.
        //
        // Boids now blend additively (the missing switch fixed earlier in this
        // branch), so a dense cluster genuinely accumulates past 1.0 -- that is
        // exactly what should glow, and a lone boid at 0.9 should not. The
        // threshold sits just above a single boid.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 1.1 * luminanceScale(canvas),
            knee: 0.4,
            intensity: 0.25,
            radius: 0.8
          },
          tonemap: 'aces',
          dither: true
        })

        gl.bindFramebuffer(gl.FRAMEBUFFER, post ? post.sceneTarget.fbo : null)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)

        runtime.start((time, frameCount, glCtx, rt) => {
          // The runtime now owns the clamped frame delta (issue #113); this
          // file used to hand-roll the identical line.
          const dt = rt.dt
          frame++

          // Sim pass.
          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, side, side)
          sim.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(uSim('uState'), 0)
            g.uniform2f(uSim('uTexel'), 1 / side, 1 / side)
            g.uniform1f(uSim('uDt'), dt)
            g.uniform1f(uSim('uFrame'), frame)
            // Halved: these were tuned in clip space, which spans 2.0
            // vertically, while world space spans 1.0. Same behaviour, and now
            // the radii are genuinely circular rather than 5:1 ellipses.
            g.uniform2f(uSim('uRadii'), sepRadius * 0.5, aliRadius * 0.5)
            g.uniform3f(uSim('uWeights'), weights[0], weights[1], weights[2])
            g.uniform1f(uSim('uCenter'), center)
            g.uniform1f(uSim('uAspect'), aspect)
            g.uniform2f(uSim('uSpeed'), maxSpeed * 0.5, minSpeed * 0.5)
          })
          pp.swap()

          // Fade the screen slightly (trails) then draw boids additively.
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
          // Switch to additive before drawing. This was missing: the fade's
          // SRC_ALPHA/ONE_MINUS_SRC_ALPHA stayed bound, so boids composited
          // over each other instead of accumulating -- a dense cluster looked
          // exactly as bright as a lone boid, contradicting the comment above
          // and this saver's whole murmuration read (issue #116).
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
          gl.useProgram(drawProg.program)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(uDraw('uState'), 0)
          gl.uniform1f(uDraw('uSide'), side)
          gl.uniform1f(uDraw('uScale'), pointScale(canvas, 2.5))
          // Clip space is square regardless of the canvas, so a quad sized in
          // clip units is stretched by the aspect ratio. Dividing by width/height
          // keeps the arrowheads square -- badly needed on a 5:1 wall.
          gl.uniform1f(uDraw('uAspect'), aspect)
          gl.uniform2f(uDraw('uQuadScale'),
            2.0 / canvas.width, 2.0 / canvas.height)
          gl.uniform3f(uDraw('uPhase'), phase[0], phase[1], phase[2])
          quads.draw(COUNT)

          if (post) post.present()
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (fade) { fade.destroy(); fade = null }
        if (drawProg) { drawProg.destroy(); drawProg = null }
        if (quads) { quads.destroy(); quads = null }
        if (pp) { pp.destroy(); pp = null }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
