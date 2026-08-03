// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * WebGL2 fullscreen fragment-shader base helper.
 *
 * Most screensavers are a single fullscreen quad rendered with a custom
 * fragment shader (Shadertoy-style). This helper handles all the boilerplate:
 * context creation, shader compilation, the quad, the animation loop, resize,
 * and a small set of standard uniforms.
 *
 * Shadertoy-compatible uniforms provided to every fragment shader:
 *   uniform vec3  iResolution;  // viewport resolution in pixels (z = 1.0)
 *   uniform float iTime;        // seconds since the screensaver started
 *   uniform int   iFrame;       // frame counter
 *
 * Write fragment shaders against gl_FragColor via a `out vec4 fragColor;`
 * (WebGL2 / GLSL ES 3.00). A `mainImage(out vec4, in vec2 fragCoord)` entry
 * point is supported for easy Shadertoy ports — see createShaderScreensaver.
 */

const QUAD_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
out vec4 outColor;
`

// Shadertoy-style wrapper: lets a shader define mainImage() and we drive it.
const FRAGMENT_MAINIMAGE_FOOTER = `
void main() {
  vec4 color = vec4(0.0);
  mainImage(color, gl_FragCoord.xy);
  outColor = color;
}`

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    // Number the source lines so shader errors are easy to locate.
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l}`)
      .join('\n')
    throw new Error(`Shader compile error:\n${log}\n--- source ---\n${numbered}`)
  }
  return shader
}

export function linkProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram()
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Program link error:\n${log}`)
  }
  return program
}

/**
 * Create a WebGL2 runtime bound to a canvas. Returns helpers for building
 * fullscreen-quad shader programs and running an animation loop.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {object} runtime
 */
export function createGLRuntime(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance'
  })
  if (!gl) {
    throw new Error('WebGL2 is not available')
  }

  // Fullscreen quad (two triangles covering clip space).
  const quad = new Float32Array([-1, -1, 3, -1, -1, 3])
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  gl.bindVertexArray(null)

  let rafId = null
  let startTime = 0
  let frame = 0
  let onFrame = null

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
  }

  /**
   * Build a fullscreen-quad program from a fragment shader body.
   * @param {string} fragmentSource - full GLSL ES 3.00 fragment shader,
   *   OR pass `{ mainImage: source }` to use the Shadertoy footer.
   * @returns {object} program handle with draw/destroy
   */
  function createQuadProgram(fragmentSource) {
    const program = linkProgram(gl, QUAD_VERTEX_SHADER, fragmentSource)
    const aPosition = gl.getAttribLocation(program, 'aPosition')
    const uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      iFrame: gl.getUniformLocation(program, 'iFrame')
    }

    function draw(time, frameCount, extraUniforms) {
      gl.useProgram(program)
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.enableVertexAttribArray(aPosition)
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)
      if (uniforms.iResolution) gl.uniform3f(uniforms.iResolution, canvas.width, canvas.height, 1.0)
      if (uniforms.iTime) gl.uniform1f(uniforms.iTime, time)
      if (uniforms.iFrame) gl.uniform1i(uniforms.iFrame, frameCount)
      if (extraUniforms) extraUniforms(gl, program)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    function destroy() {
      gl.deleteProgram(program)
    }

    return { program, draw, destroy }
  }

  /**
   * Start the animation loop. The callback receives (time, frame, gl, runtime).
   * @param {(time:number, frame:number, gl:WebGL2RenderingContext, runtime:object)=>void} cb
   */
  function start(cb) {
    onFrame = cb
    startTime = performance.now()
    frame = 0
    resize()
    const loop = () => {
      resize()
      const time = (performance.now() - startTime) / 1000
      if (onFrame) onFrame(time, frame, gl, runtime)
      frame++
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    onFrame = null
  }

  function destroy() {
    stop()
    gl.deleteVertexArray(vao)
    gl.deleteBuffer(vbo)
  }

  const runtime = {
    gl,
    canvas,
    resize,
    createQuadProgram,
    start,
    stop,
    destroy,
    get frame() { return frame }
  }
  return runtime
}

/**
 * Convenience factory for a pure fragment-shader screensaver.
 *
 * Pass a Shadertoy-style body that implements:
 *   void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
 *
 * Returns a screensaver object compatible with the registry:
 *   { create(canvas) -> { start(), stop() } }
 *
 * @param {string} name
 * @param {string} mainImageSource - GLSL providing mainImage()
 * @returns {{ name: string, create: (canvas: HTMLCanvasElement) => { start: Function, stop: Function } }}
 */
export function createShaderScreensaver(name, mainImageSource) {
  return {
    name,
    create(canvas) {
      let runtime = null
      let prog = null
      return {
        start() {
          runtime = createGLRuntime(canvas)
          const fragmentSource = FRAGMENT_HEADER + mainImageSource + FRAGMENT_MAINIMAGE_FOOTER
          prog = runtime.createQuadProgram(fragmentSource)
          runtime.start((time, frame) => {
            prog.draw(time, frame)
          })
        },
        stop() {
          if (prog) { prog.destroy(); prog = null }
          if (runtime) { runtime.destroy(); runtime = null }
        }
      }
    }
  }
}

// =============================================================================
// Advanced helpers for simulation-style screensavers
// (ping-pong framebuffers, float textures, point/particle rendering).
// =============================================================================

const FULLSCREEN_VS = QUAD_VERTEX_SHADER

/**
 * Build a standalone fullscreen-quad program (own VAO/VBO), independent of a
 * runtime. Useful for offscreen simulation passes.
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragmentSource - full GLSL ES 3.00 fragment shader
 * @returns {{ program: WebGLProgram, draw: (setUniforms?: Function) => void, destroy: () => void }}
 */
export function createFullscreenPass(gl, fragmentSource) {
  const program = linkProgram(gl, FULLSCREEN_VS, fragmentSource)
  const aPosition = gl.getAttribLocation(program, 'aPosition')
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  function draw(setUniforms) {
    gl.useProgram(program)
    gl.bindVertexArray(vao)
    if (setUniforms) setUniforms(gl, program)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  function destroy() {
    gl.deleteProgram(program)
    gl.deleteVertexArray(vao)
    gl.deleteBuffer(vbo)
  }
  return { program, draw, destroy }
}

/**
 * Create a single float texture wrapped in a framebuffer for offscreen passes.
 * Requires the EXT_color_buffer_float extension (enabled here).
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 * @param {Float32Array|null} [data]
 * @returns {{ tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number }}
 */
export function createFloatTarget(gl, w, h, data = null) {
  gl.getExtension('EXT_color_buffer_float')
  gl.getExtension('OES_texture_float_linear')
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo, w, h }
}

/**
 * Build a program from explicit vertex + fragment shader sources.
 * Useful for point/particle rendering where the vertex shader fetches
 * per-vertex data from a texture using gl_VertexID.
 * @param {WebGL2RenderingContext} gl
 * @param {string} vsSrc
 * @param {string} fsSrc
 * @returns {{ program: WebGLProgram, destroy: () => void }}
 */
export function buildProgram(gl, vsSrc, fsSrc) {
  const program = linkProgram(gl, vsSrc, fsSrc)
  return { program, destroy() { gl.deleteProgram(program) } }
}

/**
 * Point-size scale factor for GL_POINTS screensavers.
 *
 * gl_PointSize is in device pixels, so a hardcoded value shrinks in apparent
 * size as resolution grows. On the 6000x1200 videowall a 1px point is roughly
 * 1mm of screen, which at viewing distance falls below the resolving limit of
 * normal vision -- the particle is not small, it is invisible.
 *
 * Scales by the square root of pixel *area* relative to 1080p. Area is the
 * right metric rather than either axis alone: the wall is 6000x1200, so its
 * short axis (1200) is barely above 1080p and would yield only ~1.1x, while
 * its area is 3.5x of 1080p and yields ~1.9x. Using sqrt keeps the point's
 * share of the screen constant instead of its raw pixel count.
 *
 * Floored at 1.0 so desk monitors below 1080p are unchanged, and capped at 4
 * so very large canvases do not produce blobs or tank fill rate.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {number} multiplier in [1, 4]
 */
export function pointScale(canvas) {
  const area = (canvas.width || 1) * (canvas.height || 1)
  return Math.min(4, Math.max(1, Math.sqrt(area / (1920 * 1080))))
}

/**
 * Ping-pong pair of float targets for iterative simulations.
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 * @param {Float32Array|null} [seed]
 * @returns {{ read: object, write: object, swap: () => void, destroy: () => void }}
 */
export function createPingPong(gl, w, h, seed = null) {
  let a = createFloatTarget(gl, w, h, seed)
  let b = createFloatTarget(gl, w, h, null)
  const api = {
    get read() { return a },
    get write() { return b },
    swap() { const t = a; a = b; b = t },
    destroy() {
      gl.deleteTexture(a.tex); gl.deleteFramebuffer(a.fbo)
      gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo)
    }
  }
  return api
}
