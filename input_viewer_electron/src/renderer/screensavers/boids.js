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
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale } from './gl-base.js'

const SIDE = 64 // 64x64 = 4096 boids
const SAMPLES = 32 // neighbors sampled per boid per frame

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;  // xy=pos [-1,1], zw=vel
uniform vec2 uTexel;
uniform float uSide;
uniform float uDt;
uniform float uFrame;
out vec4 outState;

const int SAMPLES = ${SAMPLES};

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
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
    vec2 d = o.xy - pos;
    float dist = length(d);
    if (dist < 0.0001) continue;
    if (dist < 0.06) sep -= d / dist * (0.06 - dist);
    if (dist < 0.18) {
      ali += o.zw;
      coh += o.xy;
      count += 1.0;
    }
  }

  vec2 acc = sep * 1.5;
  if (count > 0.0) {
    ali /= count;
    coh /= count;
    acc += (ali - vel) * 0.5;
    acc += (coh - pos) * 0.4;
  }
  // Gentle pull to center so the flock stays on-screen.
  acc += -pos * 0.05;

  vel += acc * uDt;
  float sp = length(vel);
  float maxSp = 0.5;
  if (sp > maxSp) vel = vel / sp * maxSp;
  if (sp < 0.15 && sp > 0.0) vel = vel / sp * 0.15;
  pos += vel * uDt;

  // Soft wrap.
  if (pos.x > 1.0) pos.x -= 2.0; if (pos.x < -1.0) pos.x += 2.0;
  if (pos.y > 1.0) pos.y -= 2.0; if (pos.y < -1.0) pos.y += 2.0;

  outState = vec4(pos, vel);
}`

const DRAW_VERT = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uSide;
uniform float uScale;
out float vDir;
void main() {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / uSide;
  vec4 s = texture(uState, uv);
  vDir = atan(s.w, s.z);
  gl_Position = vec4(s.xy, 0.0, 1.0);
  gl_PointSize = 2.5 * uScale;
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
in float vDir;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  float hue = vDir / 6.2831 + 0.5;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
  outColor = vec4(col, 0.9);
}`

const FADE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, 0.08); }`

export default {
  name: 'Boids',
  create(canvas) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, vao = null
    let last = 0, frame = 0
    const COUNT = SIDE * SIDE

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        const a = Math.random() * Math.PI * 2
        data[i * 4 + 0] = Math.random() * 2 - 1
        data[i * 4 + 1] = Math.random() * 2 - 1
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
        pp = createPingPong(gl, SIDE, SIDE, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        fade = createFullscreenPass(gl, FADE_FRAG)
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        vao = gl.createVertexArray()
        last = 0; frame = 0

        runtime.start((time) => {
          const dt = Math.min(time - last, 0.05) || 0.016
          last = time; frame++

          // Sim pass.
          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, SIDE, SIDE)
          sim.draw((g, p) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(g.getUniformLocation(p, 'uState'), 0)
            g.uniform2f(g.getUniformLocation(p, 'uTexel'), 1 / SIDE, 1 / SIDE)
            g.uniform1f(g.getUniformLocation(p, 'uSide'), SIDE)
            g.uniform1f(g.getUniformLocation(p, 'uDt'), dt)
            g.uniform1f(g.getUniformLocation(p, 'uFrame'), frame)
          })
          pp.swap()

          // Fade the screen slightly (trails) then draw boids additively.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          fade.draw()
          gl.useProgram(drawProg.program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(gl.getUniformLocation(drawProg.program, 'uState'), 0)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uSide'), SIDE)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uScale'), pointScale(canvas, 2.5))
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
