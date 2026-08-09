// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Matrix rain — columns of glyphs falling down the screen, brightest at the
 * leading edge and fading behind (issues #58, #177).
 *
 * Rewritten for the wall (#177). The first version drew each character as a
 * 5x7 dot matrix with every dot hashed independently, which is uniform noise
 * rather than a character: at 3000x600 it read as falling television static,
 * and a faint per-column glow lifted the whole frame to grey-brown. Three
 * things changed.
 *
 * **Real glyphs.** Characters come from the shared atlas in glyph-atlas.js --
 * the film's half-width katakana plus digits -- sampled with textureGrad so the
 * mip level is chosen from the *cell* size rather than from the screen-space
 * derivative of a fract(), which jumps a full texture width at every cell
 * boundary and would otherwise blur one column of pixels per cell.
 *
 * **Three parallax planes.** Near columns are large, fast, bright and sharp;
 * far ones are small, slow, dim and slightly defocused (a mip bias). The planes
 * composite front-to-back with occlusion, so a near glyph body genuinely covers
 * what is behind it. That is what gives the field depth rather than one flat
 * layer of texture, and the low near-plane density is what leaves the negative
 * space a 5:1 frame needs.
 *
 * **True black.** Nothing is emitted outside a glyph. The washout headroom
 * comes from near-white heads at 3.0 in the HDR target against tails at 0.4,
 * not from a lifted floor, so the bloom threshold can sit above the tails and
 * only the heads glow.
 *
 * Still essentially stateless: a column's head position is a closed-form
 * function of iTime and a per-column hash. The only per-frame upload is the
 * occasional coherent word (see WORDS), which is four scalars and a short
 * array.
 *
 * Per-activation variation (iSeed + the JS rng): column phases, speeds, tail
 * lengths and stall rhythm, density, which word appears where, and a rare
 * amber-terminal palette instead of phosphor green.
 */
import { createGLRuntime, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createPostChain } from './post-fx.js'
import { createRng } from './seed.js'
import { buildGlyphAtlas, uploadGlyphAtlas } from './glyph-atlas.js'

// The film's half-width katakana (U+FF66-U+FF9D), minus the punctuation and
// the voiced-sound marks, which are tiny and read as dirt at a distance.
const KATAKANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'
// Digits belong in the rain -- they are in the original effect and they give
// the eye something occasionally recognisable.
const RAIN_CHARS = KATAKANA + '0123456789'
// Latin, carried in the same atlas but *never* drawn by the random picker: it
// exists only so a word can briefly resolve in one column. Keeping it out of
// the rain set is what stops the field drifting from Japanese to alphabet soup.
const WORD_EXTRA = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ATLAS_CHARS = RAIN_CHARS + WORD_EXTRA

// Atlas cell size. The atlas is a single row, so its width is
// cellPx * ATLAS_CHARS.length -- 48 x 82 = 3936px, which clears the 4096 that
// the weakest plausible driver reports for MAX_TEXTURE_SIZE. 64px would be
// 5248 and would fail there. At 48px a glyph still carries ~40px of ink, and
// the near plane magnifies it about 1.6x on the wall, which LINEAR handles
// without visible softness at that viewing distance.
const ATLAS_CELL_PX = 48

// Fraction of a rain cell the glyph occupies. Below ~0.9 the columns read as
// separate characters; at 1.0 adjacent glyphs touch and the column becomes a
// solid ribbon.
const GLYPH_INSET = 0.88

// Words that occasionally resolve out of the churn in a single near column.
// Short, because the near plane is only NEAR_ROWS cells tall and the word reads
// top to bottom; and plausible as terminal output, because a random English
// word would read as a bug rather than as a wink.
const WORDS = [
  'NO SIGNAL', 'STANDBY', 'NO INPUT', 'AWAITING',
  'LAB 271', 'CONNECT', 'HDMI 01', 'WAKE UP'
]
// Upper bound on the uniform array, and on how many rows of the near plane a
// word may claim. Words are truncated to it rather than asserted against it, so
// adding a long one degrades to a clipped word rather than to a broken saver.
const MAX_WORD = 12

// Rows of cells down the screen, per plane, far to near.
//
// This is the number that #177 says was wrong: the old code sized cells from a
// 1080p reference, giving ~24px cells on the wall. Sizing is now a fraction of
// the display height, which is the closest a shader gets to a physical size.
// The wall is 10m x 2m at 6000x1200, so one pixel is 1.67mm; 15 rows makes a
// near cell 80px, i.e. 13cm tall, which subtends ~45 arcmin at 10m -- road-sign
// legible. 34 rows puts the far plane at 5.9cm, still a readable character but
// clearly further away.
const NEAR_ROWS = 15
const MID_ROWS = 22
const FAR_ROWS = 34

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec4 iSeed;
uniform sampler2D uAtlas;
uniform float uCharCount;    // cells in the atlas
uniform float uRainCount;    // atlas cells the random picker may draw from
uniform float uDensity;      // global scale on how many columns are live
uniform float uHeadGain;     // extra head brightness on a big-room display
uniform vec3 uInkLch;        // phosphor colour: OKLCH lightness, chroma, hue turns
uniform float uWordGlyph[${MAX_WORD}];
uniform float uWordLen;
uniform float uWordCol;      // near-plane column index
uniform float uWordRow;      // near-plane row of the word's first character
uniform float uWordAlpha;    // 0 = absent, 1 = fully resolved
out vec4 outColor;

${GLSL.hash}
${GLSL.palette}

const float TAU = 6.28318530718;

// Scene levels, in linear HDR. The gap between them is the whole design: tails
// stay well under 1.0 so the bright pass ignores them, heads sit far above it
// so they are the only thing that blooms. See the threshold note at the bottom
// of this file.
const float TAIL_LEVEL = 0.40;
// 3.0 rather than the 5.0 the first pass used. Above about 3.5 the head stops
// reading as a *character*: ACES flattens it to paper white, the bloom fills in
// the counters, and the leading glyph becomes a featureless blob. Because the
// head term is scaled by the plane gain, this also ranks the glow by depth --
// only the near plane (3.0) clears the bloom threshold outright, the mid plane
// (1.86) glows faintly and the far plane (0.78) not at all.
const float HEAD_LEVEL = 3.0;
// A resolved word is brighter than a tail but deliberately below the bloom
// threshold -- it should read as text, not as a light source.
const float WORD_LEVEL = 0.95;

// How much of what is behind it a glyph body covers. Not 1.0: a fully opaque
// deep-tail glyph would punch hard black holes in the plane behind it, which
// reads as a bug rather than as depth.
const float MAX_OCCLUSION = 0.95;
const float MIN_OCCLUSION = 0.35;

// Head speed modulation depth. The head's velocity is speed * (1 + STALL * sin),
// so below 1.0 it never reverses; 0.8 means the head slows to a fifth of its
// average and then runs at nearly double it, which is the stall-and-dash the
// issue asks for in place of a constant-speed exponential.
const float STALL = 0.8;

/**
 * One parallax plane of rain.
 *
 * Returns the plane's emissive colour in .rgb and its glyph coverage in .a, so
 * the caller can let a near plane occlude the ones behind it.
 *
 * rows      cells down the screen; sets the cell size and thus the apparent depth
 * speedBase average fall speed in cells per second
 * gain      brightness multiplier for the plane
 * density   fraction of columns that carry rain
 * lodBias   defocus, in mip levels; the far planes get a soft edge
 * planeId   decorrelates every hash between planes
 * ink       phosphor colour, normalised so its brightest channel is 1.0
 */
vec4 plane(vec2 frag, float rows, float speedBase, float gain, float density,
           float lodBias, float planeId, vec3 ink) {
  // Cells are sized from the height and then made to tile the width exactly.
  // Deriving both from one cellPx and taking ceil() would leave up to a cell of
  // black at the right edge, which on a 6000px wall is a visible band; the
  // residual non-squareness here is under 1%.
  float cellY = iResolution.y / rows;
  float cols = max(1.0, floor(iResolution.x / cellY + 0.5));
  float cellX = iResolution.x / cols;

  vec2 cell = floor(frag / vec2(cellX, cellY));
  vec2 inCell = fract(frag / vec2(cellX, cellY));
  // Row 0 is the top of the screen; fragCoord.y counts up from the bottom.
  float row = rows - 1.0 - cell.y;

  // Per-column key. planeId and iSeed keep the three planes, and successive
  // activations, from sharing a column layout.
  float ck = cell.x + planeId * 131.7 + iSeed.x * 977.0;

  // Coherent text, near plane only. Each character crosses over at its own
  // threshold so the word assembles out of the churn one glyph at a time
  // rather than being pasted on whole.
  float wordGlyph = -1.0;
  if (uWordAlpha > 0.0 && planeId > 1.5 && abs(cell.x - uWordCol) < 0.5) {
    float wi = row - uWordRow;
    if (wi >= 0.0 && wi < uWordLen) {
      float when = rand(vec2(cell.x, row) + 3.0) * 0.8;
      if (uWordAlpha > when) wordGlyph = uWordGlyph[int(wi)];
    }
  }
  float wordHit = wordGlyph >= 0.0 ? 1.0 : 0.0;

  // Empty columns are what give the field its vertical rhythm and the negative
  // space a 5:1 frame needs. The word's column is exempt, or a word could land
  // in a column that is never drawn.
  if (rand(ck + 41.3) > density * uDensity && wordHit < 0.5) return vec4(0.0);

  float tail = mix(6.0, 20.0, rand(ck + 7.3));
  // The dark gap after the tail clears the bottom, so a column restarts from
  // black rather than the head reappearing over its own trail. Randomised, or
  // every column would restart on the same beat.
  float cycle = rows + tail + mix(3.0, 20.0, rand(ck + 3.1));

  // Two drops per column, so a tall plane is not empty for most of its cycle.
  // Brightness is the max over both, and the glyph is a property of the cell
  // rather than of the drop, so this costs stream arithmetic only -- one atlas
  // fetch still serves the pixel.
  float bright = 0.0;
  float headness = 0.0;
  for (int k = 0; k < 2; k++) {
    float kf = float(k);
    float phase = rand(ck + 91.7 + kf * 17.0) * 137.0;
    float speed = speedBase * mix(0.7, 1.5, rand(ck + 5.9 + kf * 23.0));
    // Non-uniform fall. h(t) integrates speed * (1 + STALL * sin(w t + phase)),
    // which is monotonic for STALL < 1 -- the head can stall and accelerate but
    // never runs backwards, which would look like a rewind.
    float w = mix(0.35, 1.1, rand(ck + 13.7 + kf * 31.0));
    float h = speed * (iTime + (STALL / w) * (1.0 - cos(w * iTime + phase)));
    float head = mod(h + phase * 3.0 + kf * cycle * 0.5, cycle);

    float behind = head - row;
    if (behind < 0.0 || behind > tail) continue;
    // Exponential rather than linear: linear gives a flat grey band, this gives
    // the bright head and long dim tail the effect is known for.
    bright = max(bright, exp(-behind / (tail * 0.34)));
    // Just the leading cell and a touch of the one behind it. Wider than about
    // one cell and a whole run of characters goes white, which loses the
    // green entirely on the far planes.
    headness = max(headness, smoothstep(1.05, 0.0, behind));
  }
  if (bright <= 0.0 && wordHit < 0.5) return vec4(0.0);

  // Glyph identity. The churn is fast at the head and slow deep in the tail,
  // which is how the effect actually behaves: the leading character flickers
  // while the trail is mostly settled.
  float rate = mix(1.2, 11.0, clamp(0.7 * headness + 0.3 * bright, 0.0, 1.0));
  float tick = floor(iTime * rate + rand(cell.x * 3.1 + cell.y * 7.7 + planeId) * 10.0);
  float gi = floor(rand(vec3(cell.x + iSeed.z * 613.0, cell.y, tick + planeId * 57.0))
                   * uRainCount);
  if (wordHit > 0.5) gi = wordGlyph;

  // Inset the glyph inside its cell so characters do not touch.
  vec2 g = (inCell - 0.5) / ${GLYPH_INSET} + 0.5;
  if (g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) return vec4(0.0);
  vec2 uv = vec2((gi + g.x) / uCharCount, 1.0 - g.y);

  // Analytic derivatives instead of the implicit ones. uv is built from a
  // fract(), so its screen-space derivative is enormous on the last pixel of
  // every cell; letting texture() see that would select the coarsest mip there
  // and draw a grey seam around every character. These are the derivatives the
  // cell mapping actually implies, and scaling them by exp2(lodBias) is what
  // defocuses the far planes.
  float lod = exp2(lodBias);
  vec2 ddx = vec2(1.0 / (cellX * uCharCount * ${GLYPH_INSET}), 0.0) * lod;
  vec2 ddy = vec2(0.0, 1.0 / (cellY * ${GLYPH_INSET})) * lod;
  float lit = textureGrad(uAtlas, uv, ddx, ddy).r;
  if (lit <= 0.0) return vec4(0.0);

  // Colour. Hue is constant and only the level changes, so the trail never
  // pulses through a hue cycle; the head desaturates to near-white instead,
  // which is the detail that makes it read as Matrix rain.
  // Weighting the desaturation by the plane gain is an aerial-perspective cue:
  // a distant head is a *green* spark, only the near ones burn out to white.
  // Without it every plane's heads went white and the field read as green rain
  // with white confetti in front of it.
  vec3 tint = mix(ink, vec3(0.90, 1.00, 0.94), headness * gain);
  float level = gain * (TAIL_LEVEL * bright
                        + HEAD_LEVEL * uHeadGain * headness * headness)
                + WORD_LEVEL * uWordAlpha * wordHit;

  float occl = mix(MIN_OCCLUSION, MAX_OCCLUSION,
                   clamp(max(bright * 2.0, wordHit), 0.0, 1.0));
  return vec4(tint * level * lit, lit * occl);
}

void main() {
  // Phosphor colour in OKLCH, normalised so the brightest channel is 1.0. That
  // normalisation is what lets the level constants above mean the same thing
  // for green and for the rare amber: changing the hue changes the hue, not the
  // brightness.
  float h = TAU * uInkLch.z;
  vec3 ink = max(oklabToLinear(vec3(uInkLch.x,
                                    uInkLch.y * cos(h),
                                    uInkLch.y * sin(h))), 0.0);
  ink /= max(max(ink.r, max(ink.g, ink.b)), 1e-4);

  vec2 frag = gl_FragCoord.xy;
  // Far to near. Speeds are in cells per second, so the near plane -- whose
  // cells are 2.3x larger -- also moves that much faster in pixels, which is
  // the parallax cue doing the work.
  vec4 far  = plane(frag, ${FAR_ROWS}.0,  4.5, 0.26, 0.55, 1.15, 0.0, ink);
  vec4 mid  = plane(frag, ${MID_ROWS}.0,  6.5, 0.62, 0.42, 0.45, 1.0, ink);
  vec4 near = plane(frag, ${NEAR_ROWS}.0, 9.0, 1.00, 0.30, 0.00, 2.0, ink);

  // Over-composite the emissive planes: a nearer glyph body covers what is
  // behind it, and adds its own light on top. Anything not inside a glyph stays
  // exactly zero, which is the black background #177 asks for.
  vec3 col = far.rgb;
  col = col * (1.0 - mid.a) + mid.rgb;
  col = col * (1.0 - near.a) + near.rgb;

  outColor = vec4(col, 1.0);
}
`

export default {
  name: 'Matrix Rain',
  create(canvas, seedValue) {
    let runtime = null, gl = null, prog = null, post = null, atlasTex = null

    // Built in create(), not start(), so the palette and word order survive a
    // start/stop cycle.
    const rng = createRng(seedValue)

    // Canonical phosphor green in OKLCH: L, C, hue in turns. Green at 0.394
    // turns (142 degrees) is the sRGB green axis, and C=0.20 sits inside the
    // gamut at that lightness, so nothing clips.
    //
    // #177: the old code rolled amber 20% of the time and violet 10%, and a
    // capture that landed on amber read as a fault rather than as a variant.
    // One alternate survives, at one activation in eight, and it is the only
    // one that is plausible as a real terminal.
    const GREEN = [0.86, 0.20, 0.394]
    const AMBER = [0.82, 0.15, 0.208]
    const inkLch = rng.chance(0.125) ? AMBER : GREEN

    // How many columns carry rain, as a scale on the per-plane densities. A
    // tight range: below ~0.85 the wall looks empty and above ~1.15 the planes
    // merge back into one wall of texture.
    const density = rng.range(0.85, 1.15)

    // Word timing. Long enough between appearances that it is a surprise rather
    // than a feature of the pattern.
    const wordGap = () => rng.range(11, 22)
    const WORD_FADE = 1.1     // seconds to resolve, and to dissolve again
    const WORD_HOLD = 3.2     // seconds fully readable

    const glyphIndexOf = (ch) => {
      const i = ATLAS_CHARS.indexOf(ch)
      // Unknown characters fall back to the blank, which is the one cell in the
      // atlas guaranteed to render as nothing.
      return i < 0 ? ATLAS_CHARS.indexOf(' ') : i
    }

    let word = null
    let nextWordAt = 0
    const wordGlyphs = new Float32Array(MAX_WORD)

    /** Choose the next word, its column and its vertical position. */
    function pickWord(time) {
      const text = WORDS[rng.int(0, WORDS.length - 1)].slice(0, MAX_WORD)
      const cols = Math.max(1, Math.round(canvas.width / (canvas.height / NEAR_ROWS)))
      wordGlyphs.fill(-1)
      for (let i = 0; i < text.length; i++) wordGlyphs[i] = glyphIndexOf(text[i])
      word = {
        len: text.length,
        col: rng.int(0, cols - 1),
        // Keep the whole word on screen, and off the very top row so it does
        // not look clipped.
        row: rng.int(1, Math.max(1, NEAR_ROWS - text.length - 1)),
        start: time
      }
      nextWordAt = time + WORD_FADE * 2 + WORD_HOLD + wordGap()
    }

    /** Resolve/hold/dissolve envelope for the current word. */
    function wordAlpha(time) {
      if (!word) return 0
      const t = time - word.start
      if (t < WORD_FADE) return t / WORD_FADE
      if (t < WORD_FADE + WORD_HOLD) return 1
      const out = (t - WORD_FADE - WORD_HOLD) / WORD_FADE
      if (out >= 1) { word = null; return 0 }
      return 1 - out
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl

        // Guard the atlas width against the driver's limit rather than trusting
        // the 3936px the constants give: WebGL2 only guarantees 2048, and a
        // texture that fails to allocate would leave the saver blank.
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048
        const cellPx = Math.min(ATLAS_CELL_PX,
          Math.max(16, Math.floor(maxTex / ATLAS_CHARS.length)))
        // fontScale above the atlas default: these are single characters in a
        // grid with its own inset, so there is no need for the extra margin the
        // split-flap board wants.
        const atlas = buildGlyphAtlas(ATLAS_CHARS, { cellPx, fontScale: 0.86 })
        if (!atlas) throw new Error('Matrix rain: no 2D context for the glyph atlas')
        atlasTex = uploadGlyphAtlas(gl, atlas, ATLAS_CHARS)

        prog = runtime.createQuadProgram(FRAG)
        prog.setSeed([rng.next(), rng.next(), rng.next(), rng.next()])
        const u = createUniformCache(gl, prog.program)

        // Only the heads are lifted for a big-room display, not the whole
        // frame. luminanceScale exists for savers that are dim by design; this
        // one is bright specks on black, and multiplying the tails as well
        // would raise exactly the floor #177 wants pushed back to zero.
        const headGain = luminanceScale(canvas)

        word = null
        nextWordAt = wordGap()

        runtime.start((time, frame) => {
          if (!word && time >= nextWordAt) pickWord(time)
          const alpha = wordAlpha(time)

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }

          prog.draw(time, frame, (g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, atlasTex)
            g.uniform1i(u('uAtlas'), 0)
            g.uniform1f(u('uCharCount'), ATLAS_CHARS.length)
            g.uniform1f(u('uRainCount'), RAIN_CHARS.length)
            g.uniform1f(u('uDensity'), density)
            g.uniform1f(u('uHeadGain'), headGain)
            g.uniform3f(u('uInkLch'), inkLch[0], inkLch[1], inkLch[2])
            g.uniform1fv(u('uWordGlyph'), wordGlyphs)
            g.uniform1f(u('uWordLen'), word ? word.len : 0)
            g.uniform1f(u('uWordCol'), word ? word.col : -1)
            g.uniform1f(u('uWordRow'), word ? word.row : -1)
            g.uniform1f(u('uWordAlpha'), alpha)
          })

          if (post) post.present()
        })

        // Bloom threshold, measured rather than guessed (the HDR-vs-LDR note in
        // post-fx.js). This saver writes TAIL_LEVEL 0.34 into the HDR target for
        // a tail cell and gain * HEAD_LEVEL for a head -- 0.78 far, 1.86 mid,
        // 3.0 near. A threshold of 1.2 therefore sits well above every tail and
        // above the far heads, so the glow is confined to the two nearer planes
        // and ranks with depth. The old 0.55 caught the tails as well, which
        // over a full-width field of lit cells is what washed the whole frame to
        // grey-brown. Intensity and radius are likewise down from 0.42/0.8: at
        // 3000px a radius-1.0 pyramid spreads a head into a palm-sized grey
        // smudge, which is the same wash arriving by another route.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 1.2, knee: 0.5, intensity: 0.30, radius: 0.6 },
          tonemap: 'aces',
          dither: true
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (atlasTex && gl) { gl.deleteTexture(atlasTex); atlasTex = null }
        if (prog) { prog.destroy(); prog = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        word = null
      }
    }
  }
}
