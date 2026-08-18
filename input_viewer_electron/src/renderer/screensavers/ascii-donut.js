// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * ASCII doughnut — the donut.c torus, rendered as shaded ASCII characters
 * spinning on two axes (#89).
 *
 * Takes option B from the issue: the ramp glyphs are baked into a texture atlas
 * once with fillText on a detached canvas, and the fragment shader computes the
 * torus luminance per cell and indexes the atlas. Option A (rasterise the whole
 * frame in 2D and upload it) was the issue's suggestion, but it uploads a
 * canvas-sized texture every frame -- at 6000x1200 that is the dominant cost,
 * and it buys nothing here because the glyph shapes never change. Baking once
 * makes the per-frame work pure GL and resolution-independent.
 *
 * The one-context invariant matters: the shared canvas is already WebGL2, so
 * getContext('2d') on it returns null. The atlas is rasterised on a *separate*
 * detached canvas that is never added to the DOM, which sidesteps that
 * entirely.
 *
 * Per-activation variation: rotation rates and axis phases, torus proportions,
 * glyph size and palette.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
// Shared with the split-flap board (#92), which #92 asks for explicitly rather
// than each text saver baking its own atlas.
import { buildGlyphAtlas, uploadGlyphAtlas, ASCII_RAMP as RAMP } from './glyph-atlas.js'

// Atlas cell size in pixels. 64 is enough that the glyphs stay crisp when the
// GPU scales them up to wall-sized cells.
const GLYPH_PX = 64
// Target character cell height in device pixels at 1080p. Sized in angular
// terms per issue #88: a glyph that reads on a laptop can be sub-resolvable at
// 8m, so this scales with the display's short axis rather than being fixed.
//
// 26 gave ~29px cells at 6000x1200, which #182 measured as specks at wall
// distance -- the characters were unreadable, which defeats the entire effect.
// 48 gives ~53px cells: about 113 columns by 22 rows on the wall, close to
// donut.c's own 80x22 and legible across a room.
const CELL_PX = 48

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uAtlas;
uniform float uRampLen;
uniform float uCellPx;
uniform vec2 uAngles;      // the two rotation angles
uniform vec2 uTorus;       // r1 (tube), r2 (ring)
uniform vec3 uPhase;
uniform float uLumaScale;
uniform float uSeed;       // per-activation, decorrelates the per-slot hashes
uniform float uMixShapes;  // 0 = all tori, 1 = mixed solids
uniform float uCov[${RAMP.length}];  // measured ink coverage per ramp glyph, ascending
out vec4 fragColor;

${GLSL.palette}

// Ordered dither, 4x4. Built by interleaving the bits of y and x^y, which gives
// all sixteen values exactly once -- what matters for a dither is that the
// thresholds are distinct and well spread, not the particular permutation.
float bayer4(ivec2 c) {
  int x = c.x & 3;
  int y = c.y & 3;
  int a = x ^ y;
  int v = ((a & 2) >> 1) | (y & 2) | ((a & 1) << 2) | ((y & 1) << 3);
  return float(v) / 16.0;
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// Half-extent of the largest solid, in the un-scaled local space. The torus is
// the widest at tube + ring.
const float OBJ_EXTENT = 1.34;

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.y, p.y);
  return length(q) - t.x;
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdOctahedron(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

// The solid occupying one slot. variant picks the shape, prop its
// proportions; both come from the slot's own hash, so no two slots agree.
float slotSolid(vec3 p, float variant, float prop) {
  if (variant < 0.55 || uMixShapes < 0.5) {
    // Torus. prop widens the tube and narrows the ring, so slots range from a
    // fat doughnut to a thin ring without ever closing the hole.
    float tube = mix(0.26, 0.44, prop);
    float ring = mix(1.02, 0.82, prop);
    return sdTorus(p, vec2(tube * uTorus.x / 0.39, ring * uTorus.y / 0.95));
  } else if (variant < 0.8) {
    return sdRoundBox(p, vec3(mix(0.55, 0.8, prop), mix(0.8, 0.55, prop), 0.55), 0.12);
  }
  return sdOctahedron(p, mix(1.1, 1.45, prop));
}

void main() {
  // Character grid. Cells are square in pixels, so the glyphs are undistorted
  // at any aspect and a 5:1 wall simply gets many more columns.
  vec2 cell = floor(gl_FragCoord.xy / uCellPx);
  vec2 cellUv = fract(gl_FragCoord.xy / uCellPx);
  vec2 cells = floor(uResolution / uCellPx);

  // Normalised cell centre, scaled by the SHORT axis so solids stay round.
  vec2 p = (cell + 0.5 - cells * 0.5) / (min(cells.x, cells.y) * 0.5);
  p *= 1.55;

  // A ROW OF DISTINCT SOLIDS, NOT ONE TORUS REPEATED.
  //
  // The previous version folded x with mod() into a 3.4-unit cell, so a 5:1 wall
  // got the same doughnut stamped five times at identical phase -- five copies
  // tumbling in lockstep, which reads as a rendering fault rather than a design
  // (#182). The fold is gone.
  //
  // The width is divided into slots and each slot gets its OWN solid: its own
  // shape, proportions, spin phase, scale, vertical offset and depth, all drawn
  // from a hash of the slot index. Cost is unchanged -- still one distance
  // function per march step -- because a fragment only ever belongs to one slot.
  // What changes is that no two slots look alike or move together.
  //
  // Slot width follows from the SOLID's size, not the other way round. A solid's
  // half-extent is about 1.34 world units and the vertical half-span is 1.55, so
  // HEIGHT caps how large it can be -- the frame is 1200px tall however wide the
  // wall is. Choosing slots first and fitting solids into them (the first attempt
  // here) produced five small solids adrift in a mostly black frame, which trades
  // #182's tiling complaint for its emptiness complaint. Sizing the solid to the
  // height and then laying out as many slots as fit gives about nine across the
  // wall, nearly touching.
  float halfSpanX = 1.55 * (cells.x / min(cells.x, cells.y));
  float maxScale = 1.42 / OBJ_EXTENT;
  float wanted = OBJ_EXTENT * maxScale * 1.24;   // 24% air between neighbours
  float slots = max(1.0, floor(halfSpanX * 2.0 / wanted));
  float slotW = (halfSpanX * 2.0) / slots;       // redistributed to fill exactly
  // Clamped defensively. The rightmost cell lands very close to
  // 2*halfSpanX/slotW = slots, and a cell landing ON it would get slot index
  // slots -- one past the last -- whose centre sits outside the frame, showing a
  // solid sliced off at the edge.
  //
  // In practice it does not happen: p.x maxes out at halfSpanX - 1.55/cells.y,
  // just short of the boundary, and measuring ink in the last 40px was identical
  // with and without this clamp (0.01% of pixels, peak 0.298). Kept because it
  // costs one instruction and the margin depends on cells.y, which changes with
  // resolution.
  float sIdx = clamp(floor((p.x + halfSpanX) / slotW), 0.0, slots - 1.0);
  float sCentre = -halfSpanX + (sIdx + 0.5) * slotW;

  float h0 = hash11(sIdx * 7.13 + uSeed * 131.7);
  float h1 = hash11(sIdx * 3.71 + uSeed * 57.3 + 11.0);
  float h2 = hash11(sIdx * 5.17 + uSeed * 23.9 + 29.0);
  float h3 = hash11(sIdx * 11.9 + uSeed * 91.1 + 47.0);

  // Depth. Farther solids are smaller, dimmer and cooler, which is what makes
  // the row read as a scene with space in it rather than as a line of stickers.
  float depth = h2;                       // 0 = near, 1 = far
  // Depth changes size and brightness, but gently: at 0.62 the far solids were
  // small AND dim enough to read as afterthoughts rather than as distance.
  float scale = maxScale * mix(1.0, 0.82, depth) * mix(0.95, 1.04, h3);
  // Never wider than the slot, whatever the hashes ask for.
  scale = min(scale, (slotW * 0.5) / OBJ_EXTENT * 0.96);

  vec2 local = vec2(p.x - sCentre, p.y + mix(-0.1, 0.1, h1));
  vec3 ro = vec3(local / scale, -4.0);
  vec3 rd = vec3(0.0, 0.0, 1.0);

  // Each slot spins on its own phase offset, so the row never pulses together.
  float aOff = h0 * 6.2831;
  float bOff = h1 * 6.2831;
  float ca = cos(uAngles.x + aOff), sa = sin(uAngles.x + aOff);
  float cb = cos(uAngles.y + bOff), sb = sin(uAngles.y + bOff);
  mat3 rot = mat3(cb, 0.0, sb, 0.0, 1.0, 0.0, -sb, 0.0, cb)
           * mat3(1.0, 0.0, 0.0, 0.0, ca, -sa, 0.0, sa, ca);

  float variant = h3;
  float prop = h0;

  float t = 0.0;
  bool hit = false;
  vec3 hitPos = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    vec3 pos = rot * (ro + rd * t);
    float d = slotSolid(pos, variant, prop);
    if (d < 0.002) { hit = true; hitPos = pos; break; }
    if (t > 9.0) break;
    t += d * 0.7;
  }

  if (!hit) {
    // Dim ground rather than black (#88), but only just: the contrast between
    // bright glyphs and a near-black field is what survives ambient washout.
    vec3 bg = palettePerceptual(0.72, uPhase) * 0.02;
    fragColor = vec4(bg, 1.0);
    return;
  }

  // Normal by central differences on the distance function, so it is correct for
  // every shape rather than only the torus.
  float e = 0.004;
  vec3 nrm = normalize(vec3(
    slotSolid(hitPos + vec3(e, 0.0, 0.0), variant, prop) - slotSolid(hitPos - vec3(e, 0.0, 0.0), variant, prop),
    slotSolid(hitPos + vec3(0.0, e, 0.0), variant, prop) - slotSolid(hitPos - vec3(0.0, e, 0.0), variant, prop),
    slotSolid(hitPos + vec3(0.0, 0.0, e), variant, prop) - slotSolid(hitPos - vec3(0.0, 0.0, e), variant, prop)));

  // Ambient occlusion from the distance function: three taps along the normal.
  // This is what darkens the inside of the doughnut hole, where the surface
  // faces its own opposite side and a plain Lambert term reports full light.
  float ao = 0.0;
  for (int k = 1; k <= 3; k++) {
    float len = 0.06 * float(k);
    ao += max(0.0, len - slotSolid(hitPos + nrm * len, variant, prop)) / len;
  }
  ao = clamp(1.0 - ao * 0.42, 0.25, 1.0);

  // Key plus fill plus a specular, instead of donut.c's single Lambert. The ramp
  // is expressing the shading, so better shading is directly more ASCII detail.
  vec3 keyDir = normalize(vec3(-0.35, 0.75, -0.65));
  vec3 fillDir = normalize(vec3(0.7, -0.25, -0.5));
  float key = max(0.0, dot(nrm, keyDir));
  float fill = max(0.0, dot(nrm, fillDir)) * 0.32;
  vec3 halfV = normalize(keyDir + vec3(0.0, 0.0, -1.0));
  float spec = pow(max(0.0, dot(nrm, halfV)), 22.0) * 0.55;
  float lum = clamp((key + fill) * ao + spec, 0.0, 1.0);
  // Farther solids read dimmer, which is the depth cue doing double duty as the
  // reason the ramp differs between slots.
  lum *= mix(1.0, 0.84, depth);

  // PERCEPTUALLY EVEN RAMP, WITH DITHERING BETWEEN STEPS.
  //
  // The donut.c ramp is not even: measured ink coverage jumps unevenly from '.'
  // to '@', so a linear index terraces the shading into visible bands. uCov
  // holds each glyph's measured coverage, ascending, so luminance is matched
  // against real coverage instead of position. The dither then picks between the
  // two bracketing glyphs per cell, which turns the remaining step into noise
  // the eye integrates rather than a contour line.
  int lo = 0;
  for (int i = 0; i < ${RAMP.length} - 1; i++) {
    if (uCov[i + 1] <= lum) lo = i + 1;
  }
  int hi = min(lo + 1, ${RAMP.length} - 1);
  float span = max(uCov[hi] - uCov[lo], 1e-4);
  float frac = clamp((lum - uCov[lo]) / span, 0.0, 1.0);
  int idx = (frac > bayer4(ivec2(cell))) ? hi : lo;

  vec2 atlasUv = vec2((float(idx) + cellUv.x) / uRampLen, 1.0 - cellUv.y);
  float glyph = texture(uAtlas, atlasUv).r;

  // Colour carries depth: near solids warm amber, far ones cooler green. The
  // hue is a function of depth and luminance rather than one flat red.
  float hue = mix(0.12, 0.38, depth) + lum * 0.06;
  vec3 col = palettePerceptual(hue, uPhase) * glyph;
  // Bright enough to read at 12% washout. The old 0.45 + 0.75*lum peaked barely
  // above the background; the floor here keeps even the darkest glyph legible
  // and the gain puts lit faces well clear of an ambient wash.
  col *= 0.85 + 2.1 * lum;
  col *= uLumaScale;

  fragColor = vec4(col, 1.0);
}
`

/**
 * Measured ink coverage of each ramp glyph, ascending, normalised to 0..1.
 *
 * The donut.c ramp `.,-~:;=!*#$@` is ordered by eye, not by area, and the gaps
 * between steps are uneven -- which is what terraces the shading into visible
 * bands when luminance is mapped to a ramp INDEX (#182). Measuring the atlas the
 * shader actually samples gives the real quantity to match luminance against.
 *
 * Read from the same canvas that was uploaded, so the numbers describe the
 * texture in use rather than an assumption about the font. The atlas is white
 * glyphs on opaque black and the shader reads .r, so the mean red channel over a
 * cell IS the coverage the shader sees.
 *
 * Ends are pinned to 0 and 1 after normalising: the darkest glyph must be
 * reachable at lum 0 and the brightest at lum 1, or the extremes never appear.
 *
 * @param {HTMLCanvasElement} atlas
 * @param {string} chars
 * @param {number} cellPx
 * @returns {Float32Array|null} null when the canvas cannot be read back
 */
function rampCoverage (atlas, chars, cellPx) {
  const ctx = atlas.getContext('2d')
  if (!ctx) return null
  const cov = new Float32Array(chars.length)
  for (let i = 0; i < chars.length; i++) {
    let sum = 0
    const { data } = ctx.getImageData(i * cellPx, 0, cellPx, cellPx)
    for (let k = 0; k < data.length; k += 4) sum += data[k]
    cov[i] = sum / (255 * cellPx * cellPx)
  }
  const lo = cov[0]
  const hi = cov[chars.length - 1]
  const span = hi - lo
  // A degenerate atlas (every glyph identical) would divide by ~zero; fall back
  // to an even ramp, which is what the shader did before this existed.
  if (!(span > 1e-4)) {
    for (let i = 0; i < cov.length; i++) cov[i] = i / (cov.length - 1)
    return cov
  }
  for (let i = 0; i < cov.length; i++) {
    cov[i] = Math.min(1, Math.max(0, (cov[i] - lo) / span))
  }
  cov[0] = 0
  cov[cov.length - 1] = 1
  return cov
}

export default {
  name: 'ASCII Doughnut',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null, atlasTex = null

    const rng = createRng(seedValue)
    // Rotation rates. Two incommensurate rates keep the tumble from repeating.
    const rateA = rng.range(0.5, 0.9) * (rng.chance(0.5) ? 1 : -1)
    const rateB = rng.range(0.3, 0.6) * (rng.chance(0.5) ? 1 : -1)
    const phaseA = rng.range(0, Math.PI * 2)
    const phaseB = rng.range(0, Math.PI * 2)
    // Tube and ring radii. Kept in a narrow band: a tube radius near the ring
    // radius closes the hole, and a very thin tube stops reading as a torus.
    const r1 = rng.range(0.32, 0.46)
    const r2 = rng.range(0.85, 1.05)
    const cellScale = rng.range(0.85, 1.25)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // Slot hashes are decorrelated per activation, so the same row of solids
    // never recurs.
    const slotSeed = rng.next() * 97.0
    // Two thirds of activations are a row of doughnuts in varied proportions;
    // the rest mix in boxes and octahedra. Keeping tori dominant matters -- this
    // saver is called ASCII Doughnut, and #182 asked for variety, not a different
    // screensaver.
    const mixShapes = rng.chance(0.34) ? 1 : 0

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        pass = createFullscreenPass(gl, FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        // Bake the glyph atlas once. If a 2D context is somehow unavailable the
        // saver cannot draw, so fail loudly rather than rendering blank -- the
        // registry catches it and falls back to the DVD logo.
        const atlas = buildGlyphAtlas(RAMP, { cellPx: GLYPH_PX })
        if (!atlas) throw new Error('ASCII doughnut: no 2D context for the glyph atlas')
        atlasTex = uploadGlyphAtlas(gl, atlas, RAMP)
        // Measured after upload, from the same canvas, so the ramp the shader
        // matches against describes the texture it is sampling.
        const coverage = rampCoverage(atlas, RAMP, GLYPH_PX) ||
          Float32Array.from(RAMP, (_, i) => i / (RAMP.length - 1))

        runtime.start((time) => {
          const cellPx = CELL_PX * cellScale *
            Math.max(0.6, Math.min(canvas.width, canvas.height) / 1080)

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          pass.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, atlasTex)
            g.uniform1i(u('uAtlas'), 0)
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform1f(u('uRampLen'), RAMP.length)
            g.uniform1f(u('uCellPx'), cellPx)
            g.uniform2f(u('uAngles'), phaseA + time * rateA, phaseB + time * rateB)
            g.uniform2f(u('uTorus'), r1, r2)
            g.uniform3f(u('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
            g.uniform1f(u('uSeed'), slotSeed)
            g.uniform1f(u('uMixShapes'), mixShapes)
            g.uniform1fv(u('uCov'), coverage)
          })
        })
      },
      stop() {
        if (atlasTex && gl) { gl.deleteTexture(atlasTex); atlasTex = null }
        if (pass) { pass.destroy(); pass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
