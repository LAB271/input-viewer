// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * White Particles — a clean monochrome drifting particle field. Tens of
 * thousands of white points flow through a gently rotating noise field and
 * twinkle, leaving soft trails. Calm and minimal (contrast to the colorful
 * Particle Swarm).
 *
 * Per-activation variation: the flow field is sampled at a random spatial
 * offset and scale, and the flow speed, drift direction/magnitude and twinkle
 * rate are all perturbed.
 *
 * The spatial offset is the one that matters. The field is a hash-based value
 * noise evaluated at the particle's own position, so with uTime starting at 0
 * on every start() the particles always fell into the same eddies in the same
 * places. A time offset alone would not fix that: uTime only translates the
 * field along its animation axis, so it slides the *same* eddy pattern past.
 * Displacing the sample point in x/y lands on genuinely different noise.
 *
 * Deliberately monochrome -- there is no palette here and none should be added.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide, fadeAlphaForHalfLife } from './gl-base.js'
import { createRng } from './seed.js'

const SIDE = 256 // 65,536 particles at 1080p
// Scales up with canvas area; capped so the wall costs ~147k particles
// rather than the ~227k that holding 1080p density exactly would need.
const MAX_SIDE = 384

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;  // xy=pos [-1,1], z=seedphase, w=life
uniform vec2 uTexel;
uniform float uTime;
uniform float uDt;
uniform vec2 uFieldOffset; // where in the noise field this activation samples
uniform float uFieldScale;
uniform float uFlowSpeed;
uniform vec2 uDrift;       // gentle constant drift, mostly downward
out vec4 outState;

float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
}
// Deliberately the original hand-rolled value noise, not the shared simplex
// library. Simplex is objectively the better noise -- no lattice artifacts, and
// curl2d evolves the field rather than sliding it -- but it gave this saver a
// different character, and the calm drifting look here was preferred. The other
// savers use the shared library; this one keeps its own field on purpose.
vec2 flow(vec2 p,float t){
  float e=0.08;
  float a=noise(p+vec2(0,e)+t)-noise(p-vec2(0,e)+t);
  float b=noise(p+vec2(e,0)-t)-noise(p-vec2(e,0)-t);
  return vec2(a,-b);
}

void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  vec2 pos = s.xy;
  float phase = s.z;
  float life = s.w;

  vec2 v = flow(pos*uFieldScale + uFieldOffset, uTime*0.05);
  pos += v * uDt * uFlowSpeed;
  pos += uDrift * uDt; // gentle drift
  life -= uDt * 0.15;

  // Respawn dead/off-screen particles at a random edge.
  if (life <= 0.0 || abs(pos.x) > 1.05 || abs(pos.y) > 1.05) {
    float r1 = hash(uv + uTime);
    float r2 = hash(uv * 1.7 - uTime);
    pos = vec2(r1, r2) * 2.0 - 1.0;
    life = 0.5 + hash(uv * 3.1 + uTime) * 0.8;
    phase = hash(uv * 5.3 + uTime);
  }
  outState = vec4(pos, phase, life);
}`

const DRAW_VERT = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uSide;
uniform float uTime;
uniform float uScale;
uniform float uTwinkle;
out float vAlpha;
void main(){
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / uSide;
  vec4 s = texture(uState, uv);
  // Twinkle from per-particle phase; fade in/out with life.
  float tw = 0.5 + 0.5 * sin(uTime * uTwinkle + s.z * 6.2831);
  float lifeFade = smoothstep(0.0, 0.2, s.w) * smoothstep(1.3, 0.6, s.w);
  vAlpha = tw * lifeFade;
  gl_Position = vec4(s.xy, 0.0, 1.0);
  // uScale multiplies the whole twinkle range, not just its floor, so the
  // 1..3px pulse keeps its proportions when scaled up for a large display.
  gl_PointSize = (1.0 + 2.0 * tw) * uScale;
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
in float vAlpha;
out vec4 outColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float soft = smoothstep(0.25, 0.0, r);
  outColor = vec4(vec3(1.0), vAlpha * soft); // white
}`

// Trail fade. Alpha arrives per frame so trail length is wall-clock rather
// than frame-count (issue #113).
const FADE_FRAG = `#version 300 es
precision highp float;
uniform float uFadeAlpha;
out vec4 outColor;
void main(){ outColor = vec4(0.0, 0.0, 0.0, uFadeAlpha); }`

// Reproduces the previous look at 60Hz, where the fixed 0.12 alpha halved a
// trail's brightness in ~0.09s.
const TRAIL_HALF_LIFE_S = 0.090

export default {
  name: 'White Particles',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, vao = null
    // Resolved in start(), once createGLRuntime has sized the canvas: the
    // particle count scales with canvas area, so it cannot be known here.
    let side = SIDE
    let count = SIDE * SIDE

    // Drawn here rather than in start() so a start/stop/start cycle keeps the
    // same look; only a fresh create() picks a new one.
    const rng = createRng(seedValue)
    // 0..48 in each axis. The noise is on a unit lattice and the field is
    // sampled at roughly unit scale, so even a few units lands in unrelated
    // cells; 48 is bounded well short of where float precision in the
    // fract()-based hash starts to band.
    const fieldOffset = [rng.range(0, 48), rng.range(0, 48)]
    // Around the tuned 1.2. Lower gives broad lazy sweeps, higher a busier,
    // more turbulent field -- both read as "calm drift", which is the point.
    const fieldScale = rng.range(0.95, 1.5)
    const flowSpeed = rng.range(0.45, 0.8)
    // Drift is nominally straight down at 0.02. Tilting it up to ~25 degrees
    // off vertical makes the field feel like it is in a different breeze each
    // time; a full 360 degrees would sometimes drift *upwards*, which reads as
    // rising embers rather than the intended settling snow.
    const driftAngle = -Math.PI / 2 + rng.around(0, 0.44)
    const driftMag = rng.range(0.012, 0.03)
    const drift = [Math.cos(driftAngle) * driftMag, Math.sin(driftAngle) * driftMag]
    // Around the tuned 3.0. The floor keeps the twinkle visible rather than a
    // slow breathe; the ceiling keeps it from strobing.
    const twinkle = rng.range(2.2, 4.0)

    function seed() {
      const data = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        data[i * 4 + 0] = rng.range(-1, 1)
        data[i * 4 + 1] = rng.range(-1, 1)
        data[i * 4 + 2] = rng.next()              // phase
        data[i * 4 + 3] = 0.2 + rng.next()        // life
      }
      return data
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        // createGLRuntime has now sized the canvas, so area-based scaling is
        // valid. Must precede seed(), which allocates count particles.
        side = particleSide(canvas, SIDE, MAX_SIDE)
        count = side * side
        pp = createPingPong(gl, side, side, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        fade = createFullscreenPass(gl, FADE_FRAG)
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        vao = gl.createVertexArray()

        runtime.start((time, frameCount, glCtx, rt) => {
          // Runtime owns the clamped frame delta now (issue #113).
          const dt = rt.dt

          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, side, side)
          sim.draw((g, p) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(g.getUniformLocation(p, 'uState'), 0)
            g.uniform2f(g.getUniformLocation(p, 'uTexel'), 1 / side, 1 / side)
            g.uniform1f(g.getUniformLocation(p, 'uTime'), time)
            g.uniform1f(g.getUniformLocation(p, 'uDt'), dt)
            g.uniform2f(g.getUniformLocation(p, 'uFieldOffset'), fieldOffset[0], fieldOffset[1])
            g.uniform1f(g.getUniformLocation(p, 'uFieldScale'), fieldScale)
            g.uniform1f(g.getUniformLocation(p, 'uFlowSpeed'), flowSpeed)
            g.uniform2f(g.getUniformLocation(p, 'uDrift'), drift[0], drift[1])
          })
          pp.swap()

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          // Fade for soft trails, then additive white points.
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          fade.draw((g, p) => {
            g.uniform1f(g.getUniformLocation(p, 'uFadeAlpha'),
              fadeAlphaForHalfLife(dt, TRAIL_HALF_LIFE_S))
          })
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
          gl.useProgram(drawProg.program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(gl.getUniformLocation(drawProg.program, 'uState'), 0)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uSide'), side)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uTime'), time)
          // Base size is the twinkle midpoint (1.0 + 2.0 * 0.5), the honest
          // representative of a size that animates over 1..3px. Passing the
          // 1.0 floor would overstate how small the points actually are and
          // inflate the large-display floor multiplier.
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uScale'), pointScale(canvas, 2.0))
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uTwinkle'), twinkle)
          gl.drawArrays(gl.POINTS, 0, count)
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
