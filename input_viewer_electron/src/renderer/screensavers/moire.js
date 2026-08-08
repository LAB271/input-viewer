// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Moiré interference — two line grids counter-rotating at slightly different
 * rates plus a concentric ring set, whose overlap produces large travelling
 * interference patterns and rosettes (#98).
 *
 * Computed analytically in a fragment shader, which for this saver is not a
 * style preference. Moiré *is* an aliasing phenomenon: drawing real geometry
 * would make the result depend on rasteriser sampling, so it would shimmer and
 * band unpredictably at different resolutions. Evaluating each grid as a
 * continuous function and band-limiting it gives controlled interference
 * instead of accidental aliasing.
 *
 * Rotation is deliberately slow. The pattern's beat frequency is far higher
 * than the rotation rate, so a small angular change moves the rosettes a long
 * way -- fast rotation reads as strobing.
 *
 * Per-activation variation (iSeed): grid frequencies, the rate difference that
 * sets the beat, ring density and palette rotation.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.worldSpace}
${GLSL.palette}

vec2 rotate(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}

/**
 * One band-limited line grid.
 *
 * The naive form, step(0.5, fract(x)), aliases hard: at wall scale the stripe
 * period approaches the pixel pitch and the result is noise. Comparing against
 * the screen-space derivative fades a grid out as it approaches the Nyquist
 * limit, so the interference stays clean instead of breaking up.
 */
float lineGrid(vec2 p, float freq) {
  float v = p.x * freq;
  float wave = sin(v * 6.2831853);
  // Width of one period in pixels, via the derivative of the phase.
  float period = fwidth(v);
  // Fade the grid out when a period gets close to a pixel.
  float visible = 1.0 - smoothstep(0.35, 0.75, period);
  float aa = max(period * 2.5, 1e-4);
  return smoothstep(-aa, aa, wave) * visible;
}

/** Concentric rings, band-limited the same way. */
float ringGrid(vec2 p, float freq) {
  float r = length(p) * freq;
  float wave = sin(r * 6.2831853);
  float period = fwidth(r);
  float visible = 1.0 - smoothstep(0.35, 0.75, period);
  float aa = max(period * 2.5, 1e-4);
  return smoothstep(-aa, aa, wave) * visible;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World space -- divide by the short axis so the rings stay circular and the
  // grid spacing is the same physical size at any aspect (issue #114).
  vec2 uv = worldFromFrag(fragCoord, iResolution.xy);

  // Grid frequency in cycles per world unit. Scaled against the short axis so
  // the pattern is not far denser on the wall than in a window -- one of the
  // acceptance criteria, and the reason this cannot be a fixed constant.
  float baseFreq = 26.0 + iSeed.x * 16.0;

  // Two counter-rotating grids. The rate *difference* sets the beat frequency,
  // so it is kept small: the prototype's 0.07 and -0.058 are the reference
  // point, and widening the gap makes the rosettes race.
  float rateA =  0.055 + iSeed.y * 0.030;
  float rateB = -0.048 - iSeed.z * 0.026;
  float a1 = iTime * rateA + iSeed.w * 6.2831;
  float a2 = iTime * rateB + iSeed.x * 6.2831;

  float g1 = lineGrid(rotate(uv, a1), baseFreq);
  float g2 = lineGrid(rotate(uv, a2), baseFreq * (1.0 + 0.04 * iSeed.y));

  // Ring set, drifting slowly off-centre so the rosette centre moves.
  vec2 ringCentre = vec2(sin(iTime * 0.031) * 0.10, cos(iTime * 0.027) * 0.07);
  float rings = ringGrid(uv - ringCentre, baseFreq * (0.55 + 0.25 * iSeed.z));

  // Multiplying the two line grids is what produces the interference: the
  // product is bright only where both are bright, and the slow relative
  // rotation sweeps that coincidence across the screen.
  float interference = g1 * g2;
  // Rings added rather than multiplied, so they overlay the beat pattern
  // instead of gating it away entirely.
  float field = clamp(interference * 0.85 + rings * interference * 0.6, 0.0, 1.0);

  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  // Hue follows the beat, so the moving rosettes shift colour as they travel.
  vec3 col = palettePerceptual(0.15 + field * 0.35 + iTime * 0.03, phase);
  col *= field;

  // Dim ground rather than black (issue #88).
  vec3 bg = palettePerceptual(0.72 + iSeed.y, phase) * 0.045;

  fragColor = vec4(mix(bg, col, field), 1.0);
}
`

// Bloom on the bright interference bands. Threshold from the measured peak,
// per the HDR-vs-LDR note in post-fx.js.
export default createShaderScreensaver('Moire Interference', SHADER, {
  postFX: { bloom: { threshold: 0.4, knee: 0.3, intensity: 0.28, radius: 0.85 } }
})
