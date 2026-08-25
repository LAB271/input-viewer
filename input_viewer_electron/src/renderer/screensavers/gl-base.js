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

// Frame observers (issue #59), module-level rather than per-runtime.
//
// Only one screensaver runs at a time against one shared canvas, and the thing
// that wants the pixels -- Art-Net reactive mode -- is installed once by
// renderer.js and outlives every activation. Per-runtime registration would mean
// re-subscribing on every rotation, from code that has no reference to the
// runtime a saver built inside its own start().
const frameObservers = []

/**
 * Watch the rendered frame at low resolution.
 *
 * The callback receives `(rgba, pixelCount)` -- packed RGBA bytes for a sparse
 * grid of tiles spread across the finished frame, not an image, so treat it as a
 * bag of samples rather than something with a layout. Called once per rendered
 * frame; the observer is expected to rate-limit itself (the Art-Net client sends
 * at 1Hz). Registering costs one branch per frame when nobody is listening.
 *
 * @param {(rgba: Uint8Array, pixelCount: number) => void} fn
 * @returns {() => void} unsubscribe
 */
/**
 * Live frame counters, one per running runtime.
 *
 * The wall reported lag that none of the measurements on a dev machine reproduce,
 * and there was no way to see the frame rate the wall was actually achieving.
 * This is the cheapest possible instrument: one property increment per frame in a
 * loop that already increments a counter, and nothing else on the hot path. No
 * readback, no allocation, no timing call.
 *
 * Keyed by label so several concurrent runtimes stay distinguishable -- in dual
 * view with no signal there are two split-flap boards AND possibly a screensaver,
 * each with its own runtime, and an aggregate figure would hide which one is slow.
 */
const liveRuntimes = new Set()

/**
 * Label the next runtime that gets created.
 *
 * The 30 savers all call createGLRuntime(canvas) from inside their own create(),
 * so the name lives one level up -- in the registry, which knows which entry it is
 * instantiating. Rather than thread a label through 30 files, whoever is about to
 * instantiate announces it here.
 *
 * Consumed on use, so a label cannot leak onto an unrelated runtime built later.
 */
let pendingRuntimeLabel = null
export function setNextRuntimeLabel(label) {
  pendingRuntimeLabel = label || null
}

/**
 * Read and reset every live runtime's frame count.
 *
 * Returns one entry per runtime with the frames drawn and the wall-clock interval
 * they were drawn over, leaving the caller to compute a rate -- so a caller that
 * samples irregularly still gets an honest number.
 *
 * @returns {Array<{label: string, frames: number, seconds: number, width: number, height: number}>}
 */
export function sampleFrameCounters(now = performance.now()) {
  const out = []
  for (const rec of liveRuntimes) {
    const seconds = (now - rec.since) / 1000
    out.push({
      label: rec.label,
      frames: rec.frames,
      seconds,
      preMs: rec.preMs,
      drawMs: rec.drawMs,
      worstMs: rec.worstMs,
      lateCount: rec.lateCount,
      // Mean ms between late frames, or 0 if fewer than two happened.
      latePeriodMs: rec.lateGapCount ? rec.lateGapSum / rec.lateGapCount : 0,
      width: rec.canvas.width,
      height: rec.canvas.height,
    })
    rec.frames = 0
    rec.preMs = 0
    rec.drawMs = 0
    rec.worstMs = 0
    rec.lateCount = 0
    rec.lateGapSum = 0
    rec.lateGapCount = 0
    rec.since = now
  }
  return out
}

/**
 * Geometry of the frame sample grid handed to observers.
 *
 * Exported because a consumer that wants to know WHERE in the frame the light is
 * -- rather than just its average colour -- cannot recover the layout from a flat
 * byte array. The Art-Net spot needs exactly that.
 *
 * Tiles are written row-major, ty outer and tx inner. **ty = 0 is the BOTTOM row**:
 * gl.readPixels has its origin at the bottom-left, so a consumer mapping a tile to
 * a screen position has to flip y or the picture comes out upside-down.
 */
export const SAMPLE_GRID = Object.freeze({ tile: 8, tilesX: 8, tilesY: 4 })
export const SAMPLE_COUNT =
  SAMPLE_GRID.tile * SAMPLE_GRID.tile * SAMPLE_GRID.tilesX * SAMPLE_GRID.tilesY
const { tile: TILE, tilesX: TILES_X, tilesY: TILES_Y } = SAMPLE_GRID

export function observeFrames(fn) {
  frameObservers.push(fn)
  return () => {
    const i = frameObservers.indexOf(fn)
    if (i >= 0) frameObservers.splice(i, 1)
  }
}

/** How many observers are registered. Exported so the wiring is testable. */
export function frameObserverCount() {
  return frameObservers.length
}

/**
 * Smallest gap between readbacks.
 *
 * The readback used to run on EVERY frame, and the doc here said observers were
 * "expected to rate-limit itself". They can only rate-limit the *send* -- the
 * readback has already happened by the time they are called, so the expensive part
 * was never limited by anything.
 *
 * That cost 40x on the videowall. Each notify does TILES_X*TILES_Y = 32 synchronous
 * gl.readPixels, and a sync readback on a DISCRETE GPU is a full pipeline stall plus
 * a PCIe transfer. Two split-flap boards in dual view are two runtimes, so 64 stalls
 * per frame: the wall measured 1.4 fps where the same board manages 118.9 in a
 * harness that registers no observer. It went unnoticed because the development
 * machine is Apple Silicon, where unified memory makes readPixels nearly free -- the
 * same test there measured 4%.
 *
 * 1Hz because the only consumer (Art-Net, #59) sends at 1Hz. Sampling faster than
 * the consumer can use is the definition of waste.
 */
const FRAME_OBSERVER_MIN_INTERVAL_MS = 1000

/**
 * How much longer than the running pace a frame gap has to be to count as late.
 *
 * 1.5x, so one skipped vsync at any refresh rate is caught: at 60Hz an ideal gap is
 * 16.7ms and a single drop is 33.3ms, which is 2x. Anything under 1.5x is jitter
 * rather than a dropped frame.
 */
export const LATE_FRAME_FACTOR = 1.5

/**
 * Create a WebGL2 runtime bound to a canvas. Returns helpers for building
 * fullscreen-quad shader programs and running an animation loop.
 *
 * **Sizes the canvas backing store before returning** (issue #190), so a caller
 * may derive an aspect, a particle count or a simulation grid from
 * `canvas.width`/`canvas.height` immediately, without waiting for `start()`.
 * Fifteen savers rely on this; it was not true before #190 and the resulting
 * error only showed on the first saver to run after page load.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {object} runtime
 */
export function createGLRuntime(canvas, options = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance'
  })
  if (!gl) {
    throw new Error('WebGL2 is not available')
  }

  // Frame counter for this runtime. `label` is what shows up in the fps report;
  // anonymous runtimes are still counted so the total is never misleading.
  const counter = {
    label: options.label || pendingRuntimeLabel || 'unlabelled',
    frames: 0,
    since: 0,
    canvas,
    // Accumulated work per frame, split so the report can say WHERE the time goes
    // (#271 said only how many frames there were).
    //
    //   preMs   the runtime's own work before handing over -- resize(), which
    //           reads clientWidth/clientHeight and so can force a layout
    //   drawMs  the saver's onFrame callback: its actual drawing
    //
    // Anything left between (work) and (1000/fps) is time the loop spent WAITING --
    // on vsync, the compositor or the GPU. That difference is the point: it
    // distinguishes "our JS is slow" from "we are not the bottleneck at all",
    // which is not answerable from a frame count.
    preMs: 0,
    drawMs: 0,
    // Jank, which the averages cannot show (#279 replaced min/max with the timing
    // split, and a mean over 15s hides a dropped frame entirely: 4 dropped frames in
    // a 15s window moves the mean from 16.67ms to 16.74ms).
    //
    // worstMs   the longest single gap between frames in this window
    // lateCount frames whose gap exceeded LATE_FRAME_FACTOR x the window's own median
    //           pace -- relative, so it works at 60Hz, 120Hz or on a struggling wall
    //           without a hardcoded target
    worstMs: 0,
    lateCount: 0,
    lastFrameAt: 0,
    // Spacing between late frames, because the jank is reported as PERIODIC and the
    // period is what names the culprit. Everything on a timer in this app has a known
    // cadence:
    //
    //   1600ms  the detection cycle -- the only heavyweight thing left on the
    //           renderer's main thread, and it copies a whole video frame
    //   5000ms  the no-signal board's row refresh
    //  15000ms  the frame-counter sample
    //
    // Two accumulators rather than a list of timestamps, so the memory is fixed no
    // matter how long the window runs.
    lateGapSum: 0,
    lateGapCount: 0,
    lastLateAt: 0,
  }
  pendingRuntimeLabel = null

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

  // Frame sampling for observers (#59): a grid of small tiles read straight from
  // the default framebuffer.
  //
  // The obvious implementation -- blitFramebuffer the whole canvas down into a
  // small FBO and read that -- does not work here, and it is worth recording why
  // so nobody spends the afternoon on it again. The context is created with
  // `alpha: false`, so the default framebuffer is RGB8 while any renderable
  // target we can make is RGBA8, and a colour blit between the two is a format
  // mismatch: `blitFramebuffer` returns INVALID_OPERATION and the readback is all
  // zeroes. Measured, with LINEAR, with NEAREST, and with no scaling at all --
  // 1282 every time, while a direct readPixels of the same frame returned real
  // pixels. So: no blit, no FBO, no texture.
  //
  // Instead, TILES_X * TILES_Y small reads spread evenly across the frame. That
  // samples the whole composition rather than one corner, costs a few hundred
  // bytes, and is limited by the sync rather than the volume -- which is why
  // observers rate-limit themselves to 1Hz.
  // Per-runtime, so two runtimes do not starve each other of readbacks.
  let lastObserverNotify = 0
  let samplePixels = null
  let tileBuf = null

  /**
   * Read the finished frame at a sparse grid and hand it to observers.
   *
   * Runs every frame, but only while at least one observer is registered.
   */
  function notifyFrameObservers() {
    if (!samplePixels) {
      samplePixels = new Uint8Array(SAMPLE_COUNT * 4)
      tileBuf = new Uint8Array(TILE * TILE * 4)
    }
    const w = canvas.width
    const h = canvas.height
    if (w < TILE || h < TILE) return
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      let out = 0
      for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
          // Tile centres, inset so a tile never straddles the edge.
          const x = Math.min(w - TILE, Math.max(0, Math.round((tx + 0.5) * w / TILES_X - TILE / 2)))
          const y = Math.min(h - TILE, Math.max(0, Math.round((ty + 0.5) * h / TILES_Y - TILE / 2)))
          gl.readPixels(x, y, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, tileBuf)
          samplePixels.set(tileBuf, out)
          out += tileBuf.length
        }
      }
    } catch {
      // A driver that refuses the read should not take the screensaver with it.
      return
    }
    for (const fn of frameObservers) {
      try { fn(samplePixels, SAMPLE_COUNT) } catch (err) {
        console.error('[GL] frame observer threw:', err)
      }
    }
  }

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

  // Size the backing store NOW, before returning (issue #190).
  //
  // Every caller that derives something from canvas dimensions --
  // canvasAspect(), particleSide(), pointScale(), luminanceScale(), a
  // simulation grid -- does so between createGLRuntime() and runtime.start().
  // resize() used to run only inside start(), so those reads saw whatever the
  // canvas was beforehand: on a canvas nothing had sized yet, the HTML default
  // 300x150. On the 6000x1200 wall that is aspect 2.0 instead of 5.0 (world
  // space 2.5x too narrow) and area-based particle counts computed from
  // 45,000 px instead of 7.2M.
  //
  // It was intermittent, which is why it survived: the registry shares one
  // canvas across savers, so once ANY saver had run the size stuck and the next
  // saver's early read was correct. Only the first saver after page load was
  // wrong -- order-dependent, invisible on a laptop, and issue #114's failure
  // mode still live after #138 fixed it in the shaders.
  //
  // Four savers already carried a comment asserting this was true. Making it
  // true is a smaller and safer change than correcting six call sites.
  resize()

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
    // Registered on start rather than on create, so a runtime that is built and
    // never started does not appear as a 0 fps entry.
    counter.frames = 0
    counter.preMs = 0
    counter.drawMs = 0
    counter.worstMs = 0
    counter.lateCount = 0
    counter.lateGapSum = 0
    counter.lateGapCount = 0
    counter.lastFrameAt = 0
    counter.lastLateAt = 0
    counter.since = performance.now()
    liveRuntimes.add(counter)
    const loop = () => {
      // Three clock reads per frame, one of which the loop already needed. At
      // ~30ns each that is under 10us per second at 60fps -- far below what it
      // measures, which is the only way instrumentation is honest.
      const tEnter = performance.now()
      // Gap since the previous frame. Measured at the top, so it is the interval the
      // loop actually achieved -- including anything that blocked it from outside
      // this callback, which is the whole point.
      if (counter.lastFrameAt) {
        const gap = tEnter - counter.lastFrameAt
        if (gap > counter.worstMs) counter.worstMs = gap
        // The pace to compare against is this window's own mean so far, which needs
        // at least a couple of frames to mean anything.
        if (counter.frames > 2) {
          const pace = (tEnter - counter.since) / counter.frames
          if (gap > pace * LATE_FRAME_FACTOR) {
            counter.lateCount++
            if (counter.lastLateAt) {
              counter.lateGapSum += tEnter - counter.lastLateAt
              counter.lateGapCount++
            }
            counter.lastLateAt = tEnter
          }
        }
      }
      counter.lastFrameAt = tEnter
      resize()
      const tDrawStart = performance.now()
      const time = (tDrawStart - startTime) / 1000
      // Clamp so a stall (tab hidden, GPU hitch, first frame) cannot advance a
      // simulation by a huge step and blow it up. Every simulation saver used
      // to hand-roll this identical line; now the runtime owns it.
      dt = Math.min(time - lastTime, MAX_DT) || FALLBACK_DT
      lastTime = time
      if (onFrame) onFrame(time, frame, gl, runtime)
      const tDrawEnd = performance.now()
      counter.preMs += tDrawStart - tEnter
      counter.drawMs += tDrawEnd - tDrawStart
      // Frame observers (issue #59): Art-Net reactive mode needs the rendered
      // pixels, and this is the only point that is guaranteed to be INSIDE the
      // frame. Without preserveDrawingBuffer the default framebuffer's contents
      // are undefined once the frame is composited, so a separate rAF could not
      // reliably read it -- ordering against the saver's own callback is not
      // guaranteed. Runs after onFrame so it sees the finished image.
      //
      // No observer means one branch per frame and nothing else. With one, the
      // readback is rate-limited here rather than left to the observer -- see
      // FRAME_OBSERVER_MIN_INTERVAL_MS for why that distinction cost 40x.
      if (frameObservers.length) {
        const nowMs = performance.now()
        if (nowMs - lastObserverNotify >= FRAME_OBSERVER_MIN_INTERVAL_MS) {
          lastObserverNotify = nowMs
          notifyFrameObservers()
        }
      }
      frame++
      // The whole instrument: one increment. See liveRuntimes.
      counter.frames++
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
    // Dropped on stop, so a rotated-away saver stops reporting rather than
    // lingering at whatever rate it last managed.
    liveRuntimes.delete(counter)
  }

  function destroy() {
    stop()
    gl.deleteVertexArray(vao)
    gl.deleteBuffer(vbo)
    samplePixels = null
    tileBuf = null
  }

  const runtime = {
    gl,
    canvas,
    resize,
    createQuadProgram,
    /**
     * Watch the rendered frame at low resolution (issue #59).
     *
     * The callback gets `(rgba, width, height)` for a 32x16 downscale of the
     * finished frame, every frame, and is expected to rate-limit itself -- the
     * Art-Net client sends at 1Hz. Registered observers are dropped by
     * `destroy()`, so a saver's stop() cannot leak one.
     *
     * @param {(rgba: Uint8Array, w: number, h: number) => void} fn
     * @returns {() => void} unsubscribe
     */
    observeFrames,
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
