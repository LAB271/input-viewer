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
 * Plus one non-Shadertoy uniform, for per-activation variation:
 *   uniform vec4  iSeed;        // four uncorrelated randoms in [0,1)
 *
 * iTime and iFrame both reset to 0 on every start(), so a shader that derives
 * everything from them replays identically on every activation. iSeed is the
 * hook that breaks that: use it to offset phases, pick targets, or rotate
 * palettes. It is a vec4 rather than a float so a shader can vary several
 * independent things without having to decorrelate one value by hand.
 * See seed.js for where the values come from.
 *
 * Write fragment shaders against gl_FragColor via a `out vec4 fragColor;`
 * (WebGL2 / GLSL ES 3.00). A `mainImage(out vec4, in vec2 fragCoord)` entry
 * point is supported for easy Shadertoy ports — see createShaderScreensaver.
 */
import { createRng } from './seed.js'

// Frame-delta clamping. MAX_DT caps how far a simulation can advance in one
// step, so a stall (hidden tab, GPU hitch) cannot explode it; FALLBACK_DT
// covers the first frame, where there is no previous timestamp to difference.
const MAX_DT = 0.05
const FALLBACK_DT = 0.016

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
uniform vec4 iSeed;
out vec4 outColor;
`

// Shadertoy-style wrapper: lets a shader define mainImage() and we drive it.
const FRAGMENT_MAINIMAGE_FOOTER = `
void main() {
  vec4 color = vec4(0.0);
  mainImage(color, gl_FragCoord.xy);
  outColor = color;
}`

/**
 * Supersampling footer: evaluates mainImage several times per pixel on a
 * rotated grid and averages (issue #116).
 *
 * The `antialias: true` context flag is MSAA on the default framebuffer, which
 * samples *polygon edges*. A fullscreen fragment shader has no polygon edges,
 * so it does nothing at all for these savers -- raymarch has a hard-aliased
 * fractal silhouette, and the escape-time fractals render boundary filigree
 * that is the textbook aliasing case. Both *move*, so they shimmer frame to
 * frame, which is far more objectionable than static aliasing.
 *
 * Supersampling is the blunt fix, but it is the right one here: these are
 * procedural shaders with no geometry to derive analytic coverage from, and
 * they are already fill-rate bound, so the cost is predictable.
 *
 * The offsets are a rotated grid rather than an axis-aligned one. Regular grids
 * align with exactly the horizontal and vertical features that alias worst;
 * rotating decorrelates the sample pattern from the image structure.
 */
/**
 * Samples per pixel for a canvas, given a saver's requested maximum.
 *
 * Supersampling multiplies fragment cost directly: 4x samples is 4x the
 * raymarch work. That is affordable at 1080p and reckless at 6000x1200, which
 * is 3.5x the pixels -- 4x samples there would be ~14x the fragment work of a
 * 1080p single-sampled frame.
 *
 * So the count comes *down* as the canvas grows. That is the opposite of
 * pointScale and particleSide, and deliberately: those fix things that get
 * worse with size, whereas here the pixels are already smaller in angular terms
 * on a big display, so each one aliases less visibly while costing more to
 * supersample.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} requested - the saver's preferred sample count
 * @returns {number} samples to actually use
 */
function resolveSampleCount(canvas, requested) {
  const pixels = (canvas.width || 1) * (canvas.height || 1)
  const hd = 1920 * 1080
  if (pixels > hd * 3) return Math.min(requested, 2)   // wall, 4K+
  if (pixels > hd * 1.4) return Math.min(requested, 4) // 1440p
  return requested
}

function makeSupersampleFooter(samples) {
  // Rotated-grid offsets in [-0.5, 0.5] pixel space, by sample count.
  const PATTERNS = {
    2: [[-0.25, -0.25], [0.25, 0.25]],
    4: [[-0.375, -0.125], [0.125, -0.375], [-0.125, 0.375], [0.375, 0.125]],
    // 8-rook pattern: one sample per row and per column, so every horizontal
    // and vertical slice through the pixel is covered exactly once.
    8: [
      [-0.4375, -0.1875], [-0.1875, 0.3125], [0.0625, -0.4375], [0.3125, 0.0625],
      [-0.3125, 0.1875], [-0.0625, -0.3125], [0.1875, 0.4375], [0.4375, -0.0625],
    ],
  }
  const offsets = PATTERNS[samples] || PATTERNS[4]
  const body = offsets
    .map(([dx, dy]) => `  mainImage(s, gl_FragCoord.xy + vec2(${dx.toFixed(4)}, ${dy.toFixed(4)}));\n  acc += s;`)
    .join('\n')
  return `
void main() {
  vec4 acc = vec4(0.0);
  vec4 s = vec4(0.0);
${body}
  outColor = acc / ${offsets.length}.0;
}`
}

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
  let lastTime = 0
  let dt = FALLBACK_DT

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
      iFrame: gl.getUniformLocation(program, 'iFrame'),
      iSeed: gl.getUniformLocation(program, 'iSeed')
    }

    // Four randoms for iSeed, drawn once per program rather than per frame --
    // a seed that changed every frame would be noise, not variation.
    let seedVec = [0, 0, 0, 0]

    /**
     * Set the iSeed values. Called by createShaderScreensaver; exposed so a
     * hand-rolled saver using createQuadProgram directly can seed itself too.
     * @param {number[]} v four values in [0,1)
     */
    function setSeed(v) {
      seedVec = v
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
      if (uniforms.iSeed) gl.uniform4f(uniforms.iSeed, seedVec[0], seedVec[1], seedVec[2], seedVec[3])
      if (extraUniforms) extraUniforms(gl, program)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    function destroy() {
      gl.deleteProgram(program)
    }

    return { program, draw, destroy, setSeed }
  }

  /**
   * Start the animation loop. The callback receives (time, frame, gl, runtime).
   * @param {(time:number, frame:number, gl:WebGL2RenderingContext, runtime:object)=>void} cb
   */
  function start(cb) {
    onFrame = cb
    startTime = performance.now()
    frame = 0
    lastTime = 0
    dt = FALLBACK_DT
    resize()
    const loop = () => {
      resize()
      const time = (performance.now() - startTime) / 1000
      // Clamp so a stall (tab hidden, GPU hitch, first frame) cannot advance a
      // simulation by a huge step and blow it up. Every simulation saver used
      // to hand-roll this identical line; now the runtime owns it.
      dt = Math.min(time - lastTime, MAX_DT) || FALLBACK_DT
      lastTime = time
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
    get frame() { return frame },
    /**
     * Seconds since the previous frame, clamped. Read this instead of
     * differencing `time` yourself: every simulation and every trail length
     * should be wall-clock so the screensaver looks the same on a 60Hz desk
     * monitor and a 120Hz panel.
     */
    get dt() { return dt }
  }
  return runtime
}

/**
 * Convenience factory for a pure fragment-shader screensaver.
 *
 * Pass a Shadertoy-style body that implements:
 *   void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
 *
 * The shader also receives `uniform vec4 iSeed` — four uncorrelated randoms
 * in [0,1), fixed for the activation and drawn from the wall clock. Use it to
 * vary phases, targets and palettes so the saver does not replay identically
 * every time it starts.
 *
 * Returns a screensaver object compatible with the registry:
 *   { create(canvas) -> { start(), stop() } }
 *
 * @param {string} name
 * @param {string} mainImageSource - GLSL providing mainImage()
 * @returns {{ name: string, create: (canvas: HTMLCanvasElement, seed?: number|string) => { start: Function, stop: Function } }}
 */
export function createShaderScreensaver(name, mainImageSource, options = {}) {
  const { antialias = 0, postFX = null } = options
  return {
    name,
    create(canvas, seed) {
      let runtime = null
      let prog = null
      let post = null
      let stopped = false
      return {
        start() {
          stopped = false
          runtime = createGLRuntime(canvas)
          // Sample count is decided once the canvas is sized, so a desk monitor
          // can pay less than the wall. Aliasing scales with how large and how
          // distant the display is, and so should the cost of fixing it.
          const samples = antialias ? resolveSampleCount(canvas, antialias) : 0
          const footer = samples > 1
            ? makeSupersampleFooter(samples)
            : FRAGMENT_MAINIMAGE_FOOTER
          const fragmentSource = FRAGMENT_HEADER + mainImageSource + footer
          prog = runtime.createQuadProgram(fragmentSource)
          const rng = createRng(seed)
          prog.setSeed([rng.next(), rng.next(), rng.next(), rng.next()])

          const gl = runtime.gl
          runtime.start((time, frame) => {
            // Render into the HDR target when the chain is up, otherwise
            // straight to the screen. The chain is created asynchronously
            // below, so the first few frames may take the direct path -- which
            // is exactly the behaviour without postFX, so nothing breaks.
            if (post) {
              post.resize()
              gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
              gl.viewport(0, 0, canvas.width, canvas.height)
            }
            prog.draw(time, frame)
            if (post) post.present()
          })

          if (postFX) {
            // Imported lazily: post-fx.js imports from this module, so a static
            // import here would be circular.
            import('./post-fx.js').then(({ createPostChain }) => {
              if (stopped) return
              post = createPostChain(gl, canvas, postFX)
            }).catch(err => {
              // Leaves the direct-to-screen path in place.
              console.error('[Screensaver] Post-FX unavailable:', err)
            })
          }
        },
        stop() {
          stopped = true
          if (post) { post.destroy(); post = null }
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
 * Off-screen HDR colour target for accumulating trails (issue #113).
 *
 * Distinct from createFloatTarget, which backs *simulation state* -- that wants
 * RGBA32F and NEAREST for exact round-tripping of positions and velocities.
 * This is for *colour*, where RGBA16F is the better trade: ample dynamic range
 * for accumulation, half the bandwidth of 32F, and LINEAR-filterable so a later
 * bloom/downsample chain can sample it (issue #112).
 *
 * Why accumulate off-screen at all: the default framebuffer is 8-bit, and
 * additive trails there have two visible defects. Faint values quantise hard --
 * a single attractor point contributes roughly 15/255 -- and, worse, fading by
 * a small alpha has a quantisation floor. An 0.04-alpha black quad cannot take
 * a channel below about 1/(255*0.04), so dim residue never reaches zero and
 * every filament the saver has ever drawn leaves permanent ghosting.
 *
 * Falls back to null when EXT_color_buffer_float is unavailable, so callers can
 * keep their 8-bit path rather than failing to start.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 * @returns {{tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number,
 *            resize: (w: number, h: number) => void, destroy: () => void}|null}
 */
export function createHdrColorTarget(gl, w, h) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null
  // Not fatal if absent: only a smooth-sampling bloom pass needs it, and the
  // target itself still works with NEAREST.
  gl.getExtension('OES_texture_float_linear')

  const tex = gl.createTexture()
  const fbo = gl.createFramebuffer()

  function allocate(width, height) {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, Math.max(1, width), Math.max(1, height),
      0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  allocate(w, h)

  const target = {
    tex,
    fbo,
    w: Math.max(1, w),
    h: Math.max(1, h),
    /** Reallocate on canvas resize. Discards accumulated contents. */
    resize(width, height) {
      const nw = Math.max(1, width)
      const nh = Math.max(1, height)
      if (nw === target.w && nh === target.h) return
      target.w = nw
      target.h = nh
      allocate(nw, nh)
    },
    destroy() {
      gl.deleteTexture(tex)
      gl.deleteFramebuffer(fbo)
    },
  }
  return target
}

/**
 * Per-frame fade alpha for a target trail length, independent of frame rate.
 *
 * Trails were implemented as a fullscreen black quad at a *constant* per-frame
 * alpha, which makes their length a function of refresh rate: the same 0.08 is
 * twice as aggressive at 120Hz as at 60Hz, so a trail is half as long. For a
 * videowall app that is exactly the wrong dependency.
 *
 * Framing it as a half-life instead: after `halfLifeSeconds` of wall clock, a
 * trail should have decayed to half its brightness, whatever the frame rate.
 * Per frame that means keeping 2^(-dt/halfLife), so the fade alpha is one minus
 * that.
 *
 * @param {number} dt - seconds since the previous frame (runtime.dt)
 * @param {number} halfLifeSeconds - time for a trail to halve in brightness
 * @returns {number} alpha in [0,1] for the fade quad
 */
export function fadeAlphaForHalfLife(dt, halfLifeSeconds) {
  if (!(halfLifeSeconds > 0)) return 1
  const keep = Math.pow(2, -Math.max(0, dt) / halfLifeSeconds)
  return Math.min(1, Math.max(0, 1 - keep))
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

// Point sizes below this many device pixels are effectively invisible on a
// large, distant display. The videowall is 10m x 2m at 6000x1200, so one pixel
// is 1.67mm; viewed from 8m or more, a 1-2px dot subtends under ~1.3 arcmin,
// around the resolving limit of 20/20 vision. 4px gives ~2.9 arcmin at 8m,
// which reads as a distinct dot rather than a shimmer.
//
// Only applied on large canvases (see pointScale) so desk monitors, where 4px
// would look like clumsy blobs, are unaffected.
const MIN_LARGE_DISPLAY_POINT_PX = 4

/**
 * Point-size scale factor for GL_POINTS screensavers.
 *
 * gl_PointSize is in device pixels, so a hardcoded value covers the same pixel
 * count no matter how large the display is -- and thus shrinks in *angular*
 * size as the viewer moves further away.
 *
 * Scales by the square root of pixel area relative to 1080p. Area is the right
 * metric rather than either axis alone: the wall is 6000x1200, so its short
 * axis (1200) is barely above 1080p and an axis-based rule yields only ~1.1x,
 * while its area is 3.5x of 1080p and yields ~1.86x.
 *
 * The area multiplier alone is not enough for the smallest points: it takes
 * the 1.0px attractor to 1.9px, still only ~1.3 arcmin at 8m. So on large
 * canvases the result is also floored to MIN_LARGE_DISPLAY_POINT_PX, given the
 * caller's base size, which is why basePx is required.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} basePx the shader's hardcoded gl_PointSize
 * @returns {number} multiplier to apply to basePx
 */
export function pointScale(canvas, basePx) {
  const w = canvas.width || 1
  const h = canvas.height || 1
  const scale = Math.min(4, Math.max(1, Math.sqrt((w * h) / (1920 * 1080))))

  if (!isLargeDisplay(canvas)) return scale

  const floorMult = MIN_LARGE_DISPLAY_POINT_PX / basePx
  return Math.max(scale, Math.min(floorMult, 4))
}

/**
 * Simulation-texture side length for particle counts, scaled to canvas area.
 *
 * Companion to pointScale: that fixes how *big* each particle is, this fixes
 * how *many* there are. A hardcoded count spread over a larger canvas gets
 * proportionally sparser -- the wall is 3.5x the pixel area of 1080p, so the
 * same particles sit 3.5x further apart and the field reads as empty.
 *
 * Particles live in a SIDE x SIDE ping-pong texture, so count is SIDE^2 and
 * cost grows quadratically. Scaling SIDE by sqrt(area ratio) therefore grows
 * the *count* linearly with area, holding density constant.
 *
 * Two guards on cost:
 *  - `cap` bounds SIDE outright, so very large canvases go sparser rather
 *    than unboundedly expensive. On the wall this means ~1.5x sparser than
 *    1080p instead of 3.5x -- a deliberate tradeoff, since holding density
 *    exactly would need ~227k particles against the capped ~147k.
 *  - SIDE is rounded to a multiple of 8, keeping textures friendly and
 *    avoiding a reallocation for every few pixels of canvas change.
 *
 * Never scales *down*: below 1080p the base count is already tuned, and
 * thinning a laptop preview would misrepresent what the wall shows.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} baseSide the screensaver's tuned SIDE at 1080p
 * @param {number} cap maximum SIDE, bounding worst-case GPU cost
 * @returns {number} SIDE to allocate
 */
export function particleSide(canvas, baseSide, cap) {
  const w = canvas.width || 1
  const h = canvas.height || 1
  const ratio = (w * h) / (1920 * 1080)
  if (ratio <= 1) return baseSide
  const scaled = Math.round((baseSide * Math.sqrt(ratio)) / 8) * 8
  return Math.min(cap, Math.max(baseSide, scaled))
}

// How much to lift luminance on a big-room display, and the washout level it
// is sized for.
//
// The videowall is a projector screen, so stray room light adds a roughly
// uniform white floor. At the ~12% washout the preview harness emulates (L
// key), a particle written at luminance L has Weber contrast
// (L - 0.12) / 0.12 against that floor rather than L / 0.02 against black.
// Measured across the particle screensavers, most sit comfortably above 1.0
// even at 20% washout; the dim additive-accumulation ones do not, and this
// multiplier is sized to pull them back over that line.
const LARGE_DISPLAY_LUMINANCE_BOOST = 1.6

/**
 * Whether a canvas is large enough to be treated as a big-room display.
 *
 * Anything meaningfully larger than 1080p: the wall is 6000x1200 (3.5x the
 * pixel area), while a 1440p desk monitor at 1.78x should not trigger
 * big-room treatment on its own -- hence the 1.5x margin rather than 1.0x.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean}
 */
export function isLargeDisplay(canvas) {
  const w = canvas.width || 1
  const h = canvas.height || 1
  return w * h > 1920 * 1080 * 1.5
}

/**
 * Whether a canvas is big enough that ambient room light is the dominant
 * visibility problem -- i.e. a projector wall rather than a large monitor.
 *
 * Deliberately a higher bar than isLargeDisplay. That threshold (1.5x of
 * 1080p) is right for point size, where a 1440p monitor genuinely benefits
 * from slightly larger dots and the change is subtle. Brightness is far more
 * noticeable, and a 1440p desk monitor at 1.78x area has no washout problem to
 * solve -- lifting its luminance would just make dim screensavers look wrong
 * on hardware nobody complained about. 3x of 1080p keeps 1440p out while
 * still catching the wall (3.47x) and 4K (4x), which is plausibly projected.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean}
 */
export function isBigRoomDisplay(canvas) {
  const w = canvas.width || 1
  const h = canvas.height || 1
  return w * h > 1920 * 1080 * 3
}

/**
 * Luminance multiplier for screensavers that are dim by design.
 *
 * Third companion to pointScale (how big) and particleSide (how many): this is
 * how *bright*. Dim-on-black screensavers rely on contrast against a near-zero
 * black level. On a projector screen, ambient light lifts that floor and
 * crushes exactly the faint detail they depend on -- the effect reported in
 * issue #88, where the strange attractor became invisible in the room while
 * looking fine on a desk monitor.
 *
 * Returns 1.0 for anything desk-sized, including 1440p, so normal monitors and
 * the preview harness are unchanged; only big-room canvases get the lift. Kept
 * as a plain multiplier so a shader can apply it to whichever term actually
 * controls its brightness (colour, alpha, or both) rather than assuming one
 * shape.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {number} multiplier for the shader's luminance term
 */
export function luminanceScale(canvas) {
  return isBigRoomDisplay(canvas) ? LARGE_DISPLAY_LUMINANCE_BOOST : 1.0
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
