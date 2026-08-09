// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tree growth — a row of trees growing branch by branch from trunk to leaf tip,
 * holding when complete, then resetting with new trees (#95).
 *
 * The point is **progression**. Every other saver in the set is in a steady
 * state: it looks the same at second 5 as at minute 5. This one has a
 * beginning, a middle and an end, which makes it worth watching rather than
 * merely ambient. Frost is the only other pick with that quality.
 *
 * Two structural choices, both from #95 and both load-bearing:
 *
 * 1. **Growth is driven by a progress value, not by mutating a tree.** Each
 *    branch derives its own visible fraction from `progress` and its depth, so
 *    deeper branches appear later. The whole animation is therefore stateless
 *    and restarting is just setting progress back to 0.
 *
 * 2. **Branches accumulate into a texture.** Branch count is exponential in
 *    depth -- 3 children over 9 levels is 29,524 per tree, and a 6000px wall
 *    fits ~14 trees, so ~413,000 segments. That is far past what a uniform
 *    array can hold, and redrawing it every frame would be wasteful anyway
 *    since branches never move once drawn. Only newly revealed segments are
 *    rendered each frame, into a persistent target.
 *
 * Branch thickness scales with canvas size: a 1px line is sub-resolvable at
 * wall distance (#88).
 */
import {
  createGLRuntime,
  createFullscreenPass,
  createHdrColorTarget,
  luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Recursion depth and branching.
//
// #95 suggests ~9 levels, but with an occasional third child that measured
// 1,800-4,100 segments per tree. 7 levels keeps it to 400-900, so 14 trees on
// the wall is ~7,600 segments rather than ~40,000.
//
// The outermost levels are ~80% of the segment COUNT, which looked alarming
// until measured by area: length x width puts wood at 70% and foliage at 30%,
// because outer twigs are both short and thin. That is how a real tree looks,
// so the ratio needed no correction -- only the cost did.
const MAX_DEPTH = 7
const LENGTH_RATIO = 0.73

// One tree per this many device pixels, so the wall gets a row rather than a
// few giant trees.
const PX_PER_TREE = 420

// Seconds from bare trunk to full canopy, then how long to hold before reset.
const GROW_SECONDS = 14
const HOLD_SECONDS = 5
const FADE_SECONDS = 2

// Segments drawn per batch. The whole tree is precomputed; this caps how many
// newly revealed segments are pushed to the GPU in one frame so a long stall
// cannot produce a single enormous upload.
const MAX_SEGMENTS_PER_FRAME = 900

// Vertex shader for quad-expanded tapered lines: each segment is two triangles
// whose width differs at each end, which is what makes a branch taper.
const SEG_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aCorner;        // (side, along) with side in -1..1, along in 0..1
in vec4 aSegment;       // x0, y0, x1, y1 in pixels
in vec3 aStyle;         // width0, width1, foliage (0..1)
uniform vec2 uResolution;
out float vFoliage;
out float vSide;
void main() {
  vec2 a = aSegment.xy;
  vec2 b = aSegment.zw;
  vec2 dir = b - a;
  float len = max(length(dir), 1e-5);
  vec2 n = vec2(-dir.y, dir.x) / len;

  vec2 centre = mix(a, b, aCorner.y);
  float w = mix(aStyle.x, aStyle.y, aCorner.y);
  vec2 p = centre + n * aCorner.x * w * 0.5;

  vFoliage = aStyle.z;
  vSide = aCorner.x;
  gl_Position = vec4(p / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`

const SEG_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vFoliage;
in float vSide;
uniform vec3 uPhase;
out vec4 fragColor;

${GLSL.palette}

void main() {
  // Soft edge across the branch, so thick trunks do not look like hard slabs.
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));

  // Brown for wood, green for the outer levels. #95: that single colour switch
  // is what makes it read as a tree rather than an abstract fractal.
  vec3 wood = palettePerceptual(0.10 + uPhase.x * 0.05, uPhase) * 0.55;
  vec3 leaf = palettePerceptual(0.34 + uPhase.x * 0.05, uPhase);
  vec3 col = mix(wood, leaf, vFoliage);

  fragColor = vec4(col * edge, edge);
}
`

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uCanvas;
uniform vec2 uResolution;
uniform vec3 uPhase;
uniform float uLumaScale;
uniform float uFade;
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 tree = texture(uCanvas, uv);

  // Dim ground rather than black (issue #88).
  vec3 bg = palettePerceptual(0.68 + uPhase.x, uPhase) * 0.035;
  vec3 col = mix(bg, tree.rgb, min(tree.a, 1.0) * (1.0 - uFade));
  fragColor = vec4(col * uLumaScale, 1.0);
}
`

/**
 * Flatten a tree into segments, ordered by depth.
 *
 * Depth-ordered because reveal is driven by a single progress value: the first
 * N segments of the list are exactly the tree at progress N/total, so growth
 * needs no per-branch state and a reset is just N = 0.
 *
 * Exported for tests -- the geometry is checkable without a GPU.
 *
 * @returns {Array<{x0,y0,x1,y1,w0,w1,depth,foliage}>}
 */
export function buildTree(rootX, rootY, trunkLength, trunkWidth, angle, rng) {
  const segments = []
  // Breadth-first, so the array is already depth-ordered.
  let level = [{ x: rootX, y: rootY, len: trunkLength, w: trunkWidth, ang: angle, depth: 0 }]

  while (level.length > 0) {
    const next = []
    for (const b of level) {
      const x1 = b.x + Math.cos(b.ang) * b.len
      const y1 = b.y + Math.sin(b.ang) * b.len
      // Width tapers along the branch as well as between levels, so a trunk
      // narrows into its children rather than stepping down abruptly.
      const w1 = b.w * LENGTH_RATIO
      // Foliage on the outermost level only.
      //
      // Ramping over the last three levels sounds gentler but is wrong here:
      // branch count is exponential, so depth 7+ is already ~91% of every
      // segment (2,483 of 2,724 measured). Colouring that much green reads as a
      // blob rather than a tree, and the wood -- the thing that makes it a tree
      // and not a fractal -- disappears.
      const foliage = b.depth >= MAX_DEPTH ? 1 : (b.depth === MAX_DEPTH - 1 ? 0.5 : 0)

      segments.push({
        x0: b.x, y0: b.y, x1, y1,
        w0: b.w, w1, depth: b.depth, foliage
      })

      if (b.depth >= MAX_DEPTH) continue

      // Two children, diverging. A third occasionally, for asymmetry -- a
      // strictly binary tree reads as manufactured.
      const children = rng.chance(0.22) ? 3 : 2
      const spread = rng.range(0.5, 0.85)
      for (let c = 0; c < children; c++) {
        const t = children === 1 ? 0 : (c / (children - 1)) * 2 - 1
        next.push({
          x: x1,
          y: y1,
          len: b.len * LENGTH_RATIO * rng.range(0.9, 1.1),
          w: w1,
          ang: b.ang + t * spread + rng.range(-0.12, 0.12),
          depth: b.depth + 1
        })
      }
    }
    level = next
  }
  return segments
}

export default {
  name: 'Tree Growth',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let segProgram = null, segVao = null, cornerBuf = null, segBuf = null, styleBuf = null
    let display = null, target = null
    let segments = []
    let drawn = 0
    let phase = 'grow'
    let phaseStart = 0
    let elapsed = 0, lastTime = 0
    let fade = 0

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]

    function plantRow() {
      segments = []
      drawn = 0
      fade = 0
      const trees = Math.max(2, Math.min(16, Math.round(canvas.width / PX_PER_TREE)))
      for (let t = 0; t < trees; t++) {
        const x = canvas.width * (t + 0.5) / trees
        // Scale height to the canvas so trees are not clipped by accident;
        // #95 notes clipping reads acceptably but should be deliberate.
        const trunk = canvas.height * rng.range(0.20, 0.27)
        const width = Math.max(3, Math.min(canvas.width, canvas.height) / 90) * rng.range(0.8, 1.3)
        // Slight lean per tree, so a row does not look cloned.
        //
        // +PI/2, not -PI/2: gl_FragCoord and the segment positions are in
        // y-up pixel space, so a negative angle grows the tree downward off the
        // bottom of the canvas. Measured before fixing: y ranged -710..-200.
        const lean = Math.PI / 2 + rng.range(-0.13, 0.13)
        segments.push(...buildTree(x, 0, trunk, width, lean, rng))
      }
      // Depth order across the whole row, so all trees grow together rather
      // than one finishing before the next starts.
      segments.sort((a, b) => a.depth - b.depth)
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl

        target = createHdrColorTarget(gl, canvas.width, canvas.height)
        if (!target) throw new Error('Tree growth: no float target available')

        // Segment program: instanced quads would be tidier, but a plain
        // interleaved buffer rebuilt per batch is simpler and the batch is
        // capped, so the upload stays small.
        const vs = gl.createShader(gl.VERTEX_SHADER)
        gl.shaderSource(vs, SEG_VERT); gl.compileShader(vs)
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
          throw new Error('Tree segment vertex: ' + gl.getShaderInfoLog(vs))
        }
        const fs = gl.createShader(gl.FRAGMENT_SHADER)
        gl.shaderSource(fs, SEG_FRAG); gl.compileShader(fs)
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
          throw new Error('Tree segment fragment: ' + gl.getShaderInfoLog(fs))
        }
        segProgram = gl.createProgram()
        gl.attachShader(segProgram, vs); gl.attachShader(segProgram, fs)
        gl.linkProgram(segProgram)
        if (!gl.getProgramParameter(segProgram, gl.LINK_STATUS)) {
          throw new Error('Tree segment link: ' + gl.getProgramInfoLog(segProgram))
        }
        gl.deleteShader(vs); gl.deleteShader(fs)

        const aCorner = gl.getAttribLocation(segProgram, 'aCorner')
        const aSegment = gl.getAttribLocation(segProgram, 'aSegment')
        const aStyle = gl.getAttribLocation(segProgram, 'aStyle')

        segVao = gl.createVertexArray()
        gl.bindVertexArray(segVao)

        // Six corners per segment: two triangles forming a tapered quad.
        cornerBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, 0, 1, 0, -1, 1,
          1, 0, 1, 1, -1, 1
        ]), gl.STATIC_DRAW)
        gl.enableVertexAttribArray(aCorner)
        gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0)

        segBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, segBuf)
        gl.bufferData(gl.ARRAY_BUFFER, MAX_SEGMENTS_PER_FRAME * 4 * 4, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(aSegment)
        gl.vertexAttribPointer(aSegment, 4, gl.FLOAT, false, 0, 0)
        gl.vertexAttribDivisor(aSegment, 1)

        styleBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, styleBuf)
        gl.bufferData(gl.ARRAY_BUFFER, MAX_SEGMENTS_PER_FRAME * 3 * 4, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(aStyle)
        gl.vertexAttribPointer(aStyle, 3, gl.FLOAT, false, 0, 0)
        gl.vertexAttribDivisor(aStyle, 1)
        gl.bindVertexArray(null)

        display = createFullscreenPass(gl, DISPLAY_FRAG)
        const uDisplay = createUniformCache(gl, display.program)
        const uSeg = createUniformCache(gl, segProgram)
        const lumaScale = luminanceScale(canvas)

        plantRow()
        phase = 'grow'
        phaseStart = 0
        elapsed = 0
        lastTime = 0

        // Clear the accumulation target once at the start.
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        const segData = new Float32Array(MAX_SEGMENTS_PER_FRAME * 4)
        const styleData = new Float32Array(MAX_SEGMENTS_PER_FRAME * 3)

        runtime.start((time) => {
          const dt = lastTime === 0 ? 1 / 60 : Math.min(time - lastTime, 0.25)
          lastTime = time
          elapsed += dt

          if (phase === 'grow') {
            const t = Math.min(1, (elapsed - phaseStart) / GROW_SECONDS)
            // Ease so the trunk appears promptly and the fine canopy fills in
            // over the tail, which is how a tree actually reads as growing.
            const eased = t * t * (3 - 2 * t)
            const want = Math.round(eased * segments.length)

            let pushed = 0
            while (drawn < want && pushed < MAX_SEGMENTS_PER_FRAME) {
              const s = segments[drawn]
              segData[pushed * 4] = s.x0
              segData[pushed * 4 + 1] = s.y0
              segData[pushed * 4 + 2] = s.x1
              segData[pushed * 4 + 3] = s.y1
              styleData[pushed * 3] = s.w0
              styleData[pushed * 3 + 1] = s.w1
              styleData[pushed * 3 + 2] = s.foliage
              pushed++
              drawn++
            }

            if (pushed > 0) {
              // Draw the newly revealed segments into the persistent target.
              gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
              gl.viewport(0, 0, canvas.width, canvas.height)
              gl.enable(gl.BLEND)
              gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
              gl.useProgram(segProgram)
              gl.bindVertexArray(segVao)
              gl.bindBuffer(gl.ARRAY_BUFFER, segBuf)
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, segData.subarray(0, pushed * 4))
              gl.bindBuffer(gl.ARRAY_BUFFER, styleBuf)
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, styleData.subarray(0, pushed * 3))
              gl.uniform2f(uSeg('uResolution'), canvas.width, canvas.height)
              gl.uniform3f(uSeg('uPhase'),
                palettePhase[0], palettePhase[1], palettePhase[2])
              gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, pushed)
              gl.bindVertexArray(null)
              gl.disable(gl.BLEND)
            }

            if (drawn >= segments.length) { phase = 'hold'; phaseStart = elapsed }
          } else if (phase === 'hold') {
            if (elapsed - phaseStart > HOLD_SECONDS) { phase = 'fade'; phaseStart = elapsed }
          } else {
            fade = Math.min(1, (elapsed - phaseStart) / FADE_SECONDS)
            if (fade >= 1) {
              plantRow()
              gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
              gl.viewport(0, 0, canvas.width, canvas.height)
              gl.clearColor(0, 0, 0, 0)
              gl.clear(gl.COLOR_BUFFER_BIT)
              phase = 'grow'
              phaseStart = elapsed
            }
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, target.tex)
            g.uniform1i(uDisplay('uCanvas'), 0)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform3f(uDisplay('uPhase'),
              palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(uDisplay('uLumaScale'), lumaScale)
            g.uniform1f(uDisplay('uFade'), fade)
          })
        })
      },
      stop() {
        if (segProgram && gl) { gl.deleteProgram(segProgram); segProgram = null }
        if (segVao && gl) { gl.deleteVertexArray(segVao); segVao = null }
        for (const b of [cornerBuf, segBuf, styleBuf]) if (b && gl) gl.deleteBuffer(b)
        cornerBuf = segBuf = styleBuf = null
        if (display) { display.destroy(); display = null }
        if (target) { target.destroy(); target = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        segments = []
      }
    }
  }
}
