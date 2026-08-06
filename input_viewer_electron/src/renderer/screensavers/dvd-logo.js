// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * DVD logo — the classic bouncing logo, ported to WebGL2 as a textured quad.
 *
 * The logo bounces around the screen and shifts hue on each wall contact.
 * Bounce logic uses the velocity-direction guard from the #27 fix so a wall
 * contact only triggers one hue shift even if bounds change mid-flight.
 *
 * Per-activation variation: start position, travel direction, speed, size and
 * starting hue. The bounce is deterministic once those are fixed, so without
 * this every activation traced the same path off the same walls in the same
 * order -- and, being the fallback saver, it is the one seen most often.
 */
import { createGLRuntime } from './gl-base.js'
import { createRng } from './seed.js'
import logoUrl from '../logo.png'

const VERT = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
uniform vec2 uPos;     // top-left in clip-space-ish normalized [0,1]
uniform vec2 uSize;    // size in normalized [0,1]
out vec2 vUv;
void main() {
  // Convert normalized rect (origin top-left) to clip space.
  vec2 p = uPos + aPosition * uSize;      // [0,1]
  vec2 clip = vec2(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aUv;
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uHue;   // hue rotation in radians
out vec4 outColor;

// Rotate hue of an RGB color.
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cosA = cos(a);
  return c * cosA + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cosA);
}

void main() {
  vec4 tex = texture(uTex, vUv);
  if (tex.a < 0.01) discard;
  vec3 col = hueRotate(tex.rgb, uHue);
  outColor = vec4(col, tex.a);
}`

const DVD_HUES = [0.0, 1.047, 2.094, 3.142, 4.189, 5.236] // 0,60,...300 deg in rad

export default {
  name: 'DVD Logo',
  create(canvas, seedValue) {
    let runtime = null
    let gl = null
    let program = null
    let vao = null
    let texture = null
    let loc = {}

    // Per-activation variation. The bounce is fully deterministic once the
    // start position, direction and speed are fixed, so previously every
    // activation traced the identical path and hit the walls in the identical
    // order -- the logo always left (0.4, 0.4) heading down-right at 0.12/s in
    // an unrotated hue.
    const rng = createRng(seedValue)
    // Start away from the edges so the first bounce is not immediate.
    const startX = rng.range(0.25, 0.75)
    const startY = rng.range(0.25, 0.75)
    // Speed varies mildly; the direction is a random quadrant. Both components
    // keep a floor of ~0.07 so the logo never crawls along one axis, which
    // would read as it being stuck rather than travelling.
    const speed = rng.range(0.09, 0.16)
    const angle = rng.range(0.35, 1.22) // ~20..70 deg, avoids near-axis paths

    // Motion state (normalized [0,1] coordinates, origin top-left).
    const st = {
      x: startX, y: startY,
      vx: Math.cos(angle) * speed * rng.sign(),
      vy: Math.sin(angle) * speed * rng.sign(), // per second
      logoW: rng.range(0.10, 0.15), logoH: 0.07,
      hueIndex: rng.int(0, DVD_HUES.length - 1),
      lastTime: 0
    }

    function buildProgram() {
      const vs = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(vs, VERT); gl.compileShader(vs)
      const fs = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(fs, FRAG); gl.compileShader(fs)
      program = gl.createProgram()
      gl.attachShader(program, vs); gl.attachShader(program, fs)
      gl.linkProgram(program)
      gl.deleteShader(vs); gl.deleteShader(fs)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('DVD logo program link error: ' + gl.getProgramInfoLog(program))
      }
      loc = {
        aPosition: gl.getAttribLocation(program, 'aPosition'),
        aUv: gl.getAttribLocation(program, 'aUv'),
        uPos: gl.getUniformLocation(program, 'uPos'),
        uSize: gl.getUniformLocation(program, 'uSize'),
        uTex: gl.getUniformLocation(program, 'uTex'),
        uHue: gl.getUniformLocation(program, 'uHue')
      }
    }

    function buildQuad() {
      // pos (x,y) in [0,1], uv (u,v). Two triangles.
      const data = new Float32Array([
        0, 0, 0, 0,
        1, 0, 1, 0,
        0, 1, 0, 1,
        0, 1, 0, 1,
        1, 0, 1, 0,
        1, 1, 1, 1
      ])
      vao = gl.createVertexArray()
      const vbo = gl.createBuffer()
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(loc.aPosition)
      gl.vertexAttribPointer(loc.aPosition, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(loc.aUv)
      gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 16, 8)
      gl.bindVertexArray(null)
    }

    function loadTexture() {
      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // 1x1 placeholder until the image loads.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 100, 255, 255]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

      const img = new Image()
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
        // Keep logo aspect ratio: width fixed, height derived.
        const aspect = img.width / img.height
        st.logoH = st.logoW / aspect * (canvas.width / canvas.height)
      }
      img.src = logoUrl
    }

    function update(dt) {
      st.x += st.vx * dt
      st.y += st.vy * dt
      const maxX = 1.0 - st.logoW
      const maxY = 1.0 - st.logoH
      let bounced = false
      if (st.x <= 0 && st.vx < 0) { st.x = 0; st.vx = Math.abs(st.vx); bounced = true }
      else if (st.x >= maxX && st.vx > 0) { st.x = maxX; st.vx = -Math.abs(st.vx); bounced = true }
      if (st.y <= 0 && st.vy < 0) { st.y = 0; st.vy = Math.abs(st.vy); bounced = true }
      else if (st.y >= maxY && st.vy > 0) { st.y = maxY; st.vy = -Math.abs(st.vy); bounced = true }
      // Clamp in-bounds even without a registered bounce.
      st.x = Math.min(Math.max(st.x, 0), Math.max(maxX, 0))
      st.y = Math.min(Math.max(st.y, 0), Math.max(maxY, 0))
      if (bounced) st.hueIndex = (st.hueIndex + 1) % DVD_HUES.length
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        buildProgram()
        buildQuad()
        loadTexture()
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        st.lastTime = 0
        runtime.start((time) => {
          const dt = Math.min(time - st.lastTime, 0.05)
          st.lastTime = time
          update(dt)
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.useProgram(program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.uniform1i(loc.uTex, 0)
          gl.uniform2f(loc.uPos, st.x, st.y)
          gl.uniform2f(loc.uSize, st.logoW, st.logoH)
          gl.uniform1f(loc.uHue, DVD_HUES[st.hueIndex])
          gl.drawArrays(gl.TRIANGLES, 0, 6)
        })
      },
      stop() {
        if (texture) { gl.deleteTexture(texture); texture = null }
        if (program) { gl.deleteProgram(program); program = null }
        if (vao) { gl.deleteVertexArray(vao); vao = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
