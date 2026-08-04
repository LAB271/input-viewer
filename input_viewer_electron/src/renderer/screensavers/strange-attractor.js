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
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide, luminanceScale } from './gl-base.js'

const SIDE = 256 // 65,536 points
// Scales up with canvas area; capped to bound worst-case GPU cost,
// so very large displays go slightly sparser rather than very expensive.
const MAX_SIDE = 384

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
out vec4 outColor;
void main() {
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (vIdx * 0.5 + uTime * 0.03 + vec3(0.0, 0.33, 0.67)));
  // Dim + additive accumulation: brightness comes from many overlapping points
  // rather than any single one. uLum lifts it on big-room displays, where
  // ambient light raises the black floor this effect depends on (see #88).
  // Boosts the colour rather than the alpha, so the accumulation still builds
  // up gradually instead of the points turning opaque.
  outColor = vec4(min(col * 0.5 * uLum, vec3(1.0)), 0.12);
}`

const FADE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, 0.04); }`

export default {
  name: 'Strange Attractor',
  create(canvas) {
    let runtime = null, gl = null
    let sim = null, fade = null, drawProg = null, pp = null, vao = null
    // Resolved in start(), once createGLRuntime has sized the canvas: the
    // particle count scales with canvas area, so it cannot be known here.
    let side = SIDE
    let COUNT = side * side

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        data[i * 4 + 0] = (Math.random() * 2 - 1) * 2
        data[i * 4 + 1] = (Math.random() * 2 - 1) * 2
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

        runtime.start((time) => {
          // Slowly morphing Clifford parameters.
          const a = -1.4 + 0.3 * Math.sin(time * 0.05)
          const b = 1.6 + 0.3 * Math.cos(time * 0.04)
          const c = 1.0 + 0.4 * Math.sin(time * 0.03)
          const d = 0.7 + 0.3 * Math.cos(time * 0.06)

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
          fade.draw()
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
