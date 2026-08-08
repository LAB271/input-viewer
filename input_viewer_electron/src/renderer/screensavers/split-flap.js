// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Split-flap departures board — a grid of mechanical flip tiles that clatter
 * through the alphabet to land on words (#92).
 *
 * Unlike every other saver this one carries information, which is the point: on
 * a wall showing no signal, a board reading NO SIGNAL / AWAITING / STANDBY reads
 * as *intentional* rather than as a crashed app.
 *
 * Content is a static word list, which is what #92 recommends starting with.
 * Live app state (selected input, detected resolution, no-signal duration) is
 * the better version but needs a way to pass state into a saver -- the registry
 * contract is create(canvas, seed) and nothing else -- so that is left as the
 * open question the issue notes rather than plumbed speculatively here.
 *
 * Glyphs come from the shared atlas in glyph-atlas.js, which #92 asks to share
 * with the ASCII doughnut (#89) rather than solving twice.
 *
 * Per-activation variation: word order, flap speed, stagger and palette.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { buildGlyphAtlas, uploadGlyphAtlas, FLAP_CHARS } from './glyph-atlas.js'

const GLYPH_PX = 64
// Tiles are taller than they are wide, like a real board.
const TILE_RATIO = 1.45
// Rows of text on the board. Three fits a 5:1 strip without the tiles becoming
// too small to read across a room.
const ROWS = 3

// Messages, as row triples. Kept short: a long word forces narrow tiles on any
// aspect, and the whole point is legibility at distance.
const MESSAGES = [
  ['NO SIGNAL', 'AWAITING INPUT', 'STANDBY'],
  ['NO SIGNAL', 'CHECK CABLE', 'HDMI 01'],
  ['LAB 271', 'NO SIGNAL', 'READY'],
  ['STANDBY', 'NO INPUT', 'CONNECT SOURCE'],
  ['NO SIGNAL', 'SELECT INPUT', '1 2 3 4']
]

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uAtlas;
uniform sampler2D uState;    // r = current glyph index, g = flap phase 0..1
uniform vec2 uGrid;          // cols, rows
uniform vec2 uTileBox;       // tile size in pixels, including the gap
uniform vec2 uOrigin;        // pixel offset of the grid's bottom-left
uniform float uCharCount;
uniform vec3 uPhase;
uniform float uLumaScale;
out vec4 fragColor;

${GLSL.palette}

void main() {
  vec2 rel = gl_FragCoord.xy - uOrigin;
  vec2 cellF = rel / uTileBox;

  // Outside the board: dark surround.
  if (cellF.x < 0.0 || cellF.y < 0.0 || cellF.x >= uGrid.x || cellF.y >= uGrid.y) {
    fragColor = vec4(palettePerceptual(0.72, uPhase) * 0.02 * uLumaScale, 1.0);
    return;
  }

  vec2 cell = floor(cellF);
  vec2 inTile = fract(cellF);

  // Gap between tiles, so the board reads as separate flaps.
  vec2 gap = vec2(0.055, 0.045);
  if (inTile.x < gap.x || inTile.x > 1.0 - gap.x ||
      inTile.y < gap.y || inTile.y > 1.0 - gap.y) {
    fragColor = vec4(palettePerceptual(0.72, uPhase) * 0.02 * uLumaScale, 1.0);
    return;
  }
  // Re-normalise inside the tile face.
  vec2 face = (inTile - gap) / (1.0 - 2.0 * gap);

  // Row 0 of the state texture is the bottom row of the board.
  vec2 stateUv = (cell + 0.5) / uGrid;
  vec4 st = texture(uState, stateUv);
  float glyphIndex = floor(st.r + 0.5);
  float phase = st.g;

  // Tile body: two-tone, darker in the lower half, with a split line across the
  // middle. Without these it reads as flat text rather than a mechanical board.
  float lower = step(face.y, 0.5);
  vec3 body = palettePerceptual(0.66 + uPhase.x, uPhase) * (lower > 0.5 ? 0.055 : 0.075);
  // The split line itself.
  float split = 1.0 - smoothstep(0.0, 0.012, abs(face.y - 0.5));
  body = mix(body, body * 0.35, split);

  // Squash the glyph vertically mid-flap to fake the rotation. This is the
  // detail that sells the mechanism: abs(cos()) goes to zero at the halfway
  // point, so the character appears edge-on.
  float squash = abs(cos(phase * 3.14159265));
  // Guard the divide: at squash 0 the glyph is edge-on and invisible anyway.
  float gy = squash > 0.02 ? (face.y - 0.5) / squash + 0.5 : -1.0;

  vec3 col = body;
  if (gy >= 0.0 && gy <= 1.0) {
    // Inset the glyph within the tile face so characters do not touch the edges.
    vec2 g = vec2((face.x - 0.5) / 0.78 + 0.5, (gy - 0.5) / 0.82 + 0.5);
    if (g.x >= 0.0 && g.x <= 1.0 && g.y >= 0.0 && g.y <= 1.0) {
      vec2 atlasUv = vec2((glyphIndex + g.x) / uCharCount, 1.0 - g.y);
      float ink = texture(uAtlas, atlasUv).r;
      // Cream on dark, the classic board colouring. #92 expects this to survive
      // ambient-light washout better than the dim particle savers (#88).
      vec3 inkCol = palettePerceptual(0.13 + uPhase.x, uPhase) * 1.25;
      col = mix(col, inkCol, ink);
    }
  }

  col *= uLumaScale;
  fragColor = vec4(col, 1.0);
}
`

export default {
  name: 'Split Flap',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null, atlasTex = null, stateTex = null

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // Flaps per second. A real board is fast and noisy; too slow and it reads
    // as a slideshow rather than a mechanism.
    const flapRate = rng.range(11, 17)
    // How long a completed message is held before the next one.
    const holdSeconds = rng.range(5.5, 9.0)
    let messageOrder = MESSAGES.map((_, i) => i)
    // Shuffle so activations do not always open on the same message.
    for (let i = messageOrder.length - 1; i > 0; i--) {
      const j = rng.int(0, i)
      const t = messageOrder[i]; messageOrder[i] = messageOrder[j]; messageOrder[j] = t
    }

    let cols = 20
    let current = null      // Float32Array: per-tile [glyphIndex, phase, ., .]
    let target = null       // Uint8Array of target glyph indices
    let settleAt = null     // per-tile time offset, for the stagger
    let messageIndex = 0
    let messageStart = 0
    let lastTime = 0

    /** Target glyph index for a character, or 0 (blank) if not in the set. */
    function glyphIndexOf(ch) {
      const i = FLAP_CHARS.indexOf(ch.toUpperCase())
      return i < 0 ? 0 : i
    }

    /** Lay a message out, centred per row. */
    function setMessage(idx) {
      const rows = MESSAGES[messageOrder[idx % messageOrder.length]]
      for (let r = 0; r < ROWS; r++) {
        // Row 0 of the texture is the bottom of the board, so draw the first
        // line of text at the top.
        const text = (rows[r] || '').toUpperCase()
        const texRow = ROWS - 1 - r
        // Centre the word rather than left-aligning: on a wide board, text
        // jammed against the left edge is one of the failure modes #92 lists.
        const start = Math.max(0, Math.floor((cols - text.length) / 2))
        for (let c = 0; c < cols; c++) {
          const ch = (c >= start && c - start < text.length) ? text[c - start] : ' '
          const i = texRow * cols + c
          target[i] = glyphIndexOf(ch)
          // Stagger: each tile starts settling at a slightly different time, so
          // the board clatters rather than landing in unison.
          settleAt[i] = rng.range(0, 0.55) + c * 0.012
        }
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl

        // Layout. Derive columns from the aspect ratio and the tile box from
        // whichever axis is binding -- #92 documents a prototype that used a
        // fixed 9 columns and left two-thirds of the wall empty with a
        // half-tile clipped at the left edge.
        const aspect = canvas.width / canvas.height
        cols = Math.max(8, Math.min(48, Math.round(ROWS * aspect * TILE_RATIO)))
        const tileW = Math.min(canvas.width / cols, (canvas.height / ROWS) / TILE_RATIO)
        const tileH = tileW * TILE_RATIO
        const boardW = tileW * cols
        const boardH = tileH * ROWS
        // Centre the grid explicitly.
        const originX = (canvas.width - boardW) * 0.5
        const originY = (canvas.height - boardH) * 0.5

        const n = cols * ROWS
        current = new Float32Array(n * 4)
        target = new Uint8Array(n)
        settleAt = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          current[i * 4] = rng.int(0, FLAP_CHARS.length - 1)
          current[i * 4 + 1] = 0
          current[i * 4 + 3] = 1
        }
        messageIndex = 0
        setMessage(messageIndex)
        messageStart = 0
        lastTime = 0

        const atlas = buildGlyphAtlas(FLAP_CHARS, { cellPx: GLYPH_PX })
        if (!atlas) throw new Error('Split flap: no 2D context for the glyph atlas')
        atlasTex = uploadGlyphAtlas(gl, atlas)

        stateTex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, stateTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, ROWS, 0, gl.RGBA, gl.FLOAT, current)
        // NEAREST: each texel is one tile's state and must not be interpolated
        // with its neighbour, or a tile shows a blend of two glyph indices.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

        pass = createFullscreenPass(gl, FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        runtime.start((time) => {
          const dt = lastTime === 0 ? 0.016 : Math.min(time - lastTime, 0.1)
          lastTime = time

          let allSettled = true
          for (let i = 0; i < n; i++) {
            const idx = current[i * 4]
            const want = target[i]
            if (Math.round(idx) === want && current[i * 4 + 1] === 0) continue
            allSettled = false
            if (time < settleAt[i]) continue

            // Advance the flap phase; each whole phase steps one character on.
            let phase = current[i * 4 + 1] + dt * flapRate
            let glyph = idx
            while (phase >= 1.0) {
              phase -= 1.0
              // Step forward through the ramp only, like a real board.
              glyph = (Math.round(glyph) + 1) % FLAP_CHARS.length
            }
            if (Math.round(glyph) === want) {
              // Landed: stop mid-flap motion so the tile sits flat.
              current[i * 4] = want
              current[i * 4 + 1] = 0
            } else {
              current[i * 4] = glyph
              current[i * 4 + 1] = phase
            }
          }

          // Hold a completed message, then move on.
          if (allSettled) {
            if (messageStart === 0) messageStart = time
            if (time - messageStart > holdSeconds) {
              messageIndex++
              setMessage(messageIndex)
              // Stagger is measured from now.
              for (let i = 0; i < n; i++) settleAt[i] += time
              messageStart = 0
            }
          }

          gl.bindTexture(gl.TEXTURE_2D, stateTex)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, ROWS, gl.RGBA, gl.FLOAT, current)

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          pass.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, atlasTex)
            g.uniform1i(u('uAtlas'), 0)
            g.activeTexture(g.TEXTURE1)
            g.bindTexture(g.TEXTURE_2D, stateTex)
            g.uniform1i(u('uState'), 1)
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform2f(u('uGrid'), cols, ROWS)
            g.uniform2f(u('uTileBox'), tileW, tileH)
            g.uniform2f(u('uOrigin'), originX, originY)
            g.uniform1f(u('uCharCount'), FLAP_CHARS.length)
            g.uniform3f(u('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
          })
        })
      },
      stop() {
        if (atlasTex && gl) { gl.deleteTexture(atlasTex); atlasTex = null }
        if (stateTex && gl) { gl.deleteTexture(stateTex); stateTex = null }
        if (pass) { pass.destroy(); pass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
