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

// The classic donut.c ramp, dimmest to brightest.
const RAMP = '.,-~:;=!*#$@'
// Atlas cell size in pixels. 64 is enough that the glyphs stay crisp when the
// GPU scales them up to wall-sized cells.
const GLYPH_PX = 64
// Target character cell height in device pixels at 1080p. Sized in angular
// terms per issue #88: a glyph that reads on a laptop can be sub-resolvable at
// 8m, so this scales with the display's short axis rather than being fixed.
const CELL_PX = 26

/**
 * Rasterise the ramp into a single-row atlas on a detached canvas.
 *
 * Deliberately not the shared screensaver canvas: that one is WebGL2 for its
 * whole life, so a 2D context on it is impossible (#89, same trap as #90).
 */
function buildAtlas() {
  const c = document.createElement('canvas')
  c.width = GLYPH_PX * RAMP.length
  c.height = GLYPH_PX
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#fff'
  // Monospace so every glyph occupies its cell identically.
  ctx.font = `${Math.round(GLYPH_PX * 0.82)}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < RAMP.length; i++) {
    ctx.fillText(RAMP[i], (i + 0.5) * GLYPH_PX, GLYPH_PX * 0.54)
  }
  return c
}

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
out vec4 fragColor;

${GLSL.palette}

void main() {
  // Character grid. Cells are square in pixels, so the glyphs are undistorted
  // at any aspect and a 5:1 wall simply gets many more columns -- the issue
  // warns against a fixed 80x22, which would letterbox the torus into a blob.
  vec2 cell = floor(gl_FragCoord.xy / uCellPx);
  vec2 cellUv = fract(gl_FragCoord.xy / uCellPx);
  vec2 cells = floor(uResolution / uCellPx);

  // Normalised cell centre, scaled by the SHORT axis so the torus stays
  // circular rather than stretching across a wide grid.
  vec2 p = (cell + 0.5 - cells * 0.5) / (min(cells.x, cells.y) * 0.5);

  // Scale so the torus fills the short axis with a margin. It spans roughly
  // +/-(r2 + r1) ~ 1.4 world units, so the visible range is a little wider than
  // that and no more. An earlier 2.6 left it as a small central patch.
  p *= 1.55;

  // Repeat across the width on a wide canvas.
  //
  // Sizing to the short axis alone is correct for keeping the torus round, but
  // on the 5:1 wall it leaves a single doughnut occupying 16% of the width and
  // 84% of the display empty -- the letterboxing issue #89 explicitly warns
  // about. Tiling the world horizontally fills the wall with a row of
  // doughnuts, all identical and all round, instead of stretching one.
  float halfSpanX = 1.55 * (cells.x / min(cells.x, cells.y));
  float tile = 3.4;
  if (halfSpanX > tile * 0.5) {
    // Fold x into a repeating cell centred on 0, so each copy is identical.
    p.x = mod(p.x + tile * 0.5, tile) - tile * 0.5;
  }

  // Ray-march the torus. Cheaper and sharper than donut.c's point-splat
  // approach at this resolution, and it gives a real surface normal for the
  // shading, which is what the luminance ramp needs.
  float ca = cos(uAngles.x), sa = sin(uAngles.x);
  float cb = cos(uAngles.y), sb = sin(uAngles.y);
  mat3 rotA = mat3(1.0, 0.0, 0.0, 0.0, ca, -sa, 0.0, sa, ca);
  mat3 rotB = mat3(cb, 0.0, sb, 0.0, 1.0, 0.0, -sb, 0.0, cb);
  mat3 rot = rotB * rotA;

  vec3 ro = vec3(p, -4.0);
  vec3 rd = vec3(0.0, 0.0, 1.0);
  float lum = 0.0;
  float t = 0.0;
  bool hit = false;
  vec3 nrm = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    vec3 pos = rot * (ro + rd * t);
    // Torus SDF.
    vec2 q = vec2(length(pos.xz) - uTorus.y, pos.y);
    float d = length(q) - uTorus.x;
    if (d < 0.002) {
      hit = true;
      // Gradient of the torus SDF gives the normal.
      vec2 qq = vec2(length(pos.xz) - uTorus.y, pos.y);
      vec3 n = normalize(vec3(pos.x * qq.x / max(length(pos.xz), 1e-4),
                              qq.y,
                              pos.z * qq.x / max(length(pos.xz), 1e-4)));
      nrm = n;
      break;
    }
    if (t > 9.0) break;
    t += d * 0.7;
  }

  if (!hit) {
    // Background: dim ground rather than black (issue #88).
    vec3 bg = palettePerceptual(0.72, uPhase) * 0.04;
    fragColor = vec4(bg, 1.0);
    return;
  }

  // Lambert against a fixed light, the same lighting model donut.c uses.
  vec3 lightDir = normalize(vec3(0.0, 0.7, -0.7));
  lum = clamp(dot(nrm, lightDir), 0.0, 1.0);

  // Index the ramp. floor() rather than a smooth blend: quantisation into
  // discrete characters is the entire point of the effect.
  float idx = floor(lum * (uRampLen - 0.001));
  vec2 atlasUv = vec2((idx + cellUv.x) / uRampLen, 1.0 - cellUv.y);
  float glyph = texture(uAtlas, atlasUv).r;

  // Phosphor green by default, rotated per activation.
  vec3 col = palettePerceptual(0.35 + lum * 0.25, uPhase) * glyph;
  // Brighter glyphs for brighter surfaces, so the ramp reads as shading and
  // not just as different characters.
  col *= 0.45 + 0.75 * lum;
  col *= uLumaScale;

  fragColor = vec4(col, 1.0);
}
`

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
        const atlas = buildAtlas()
        if (!atlas) throw new Error('ASCII doughnut: no 2D context for the glyph atlas')
        atlasTex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, atlasTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas)
        // LINEAR so glyph edges stay smooth when scaled up to wall-sized cells;
        // CLAMP so sampling at a cell edge cannot bleed the neighbouring glyph.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

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
