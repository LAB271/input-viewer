// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Flow field — streamlines traced through an animated curl-noise field.
 *
 * Rendered entirely in the fragment shader: for each pixel we integrate a
 * short path backwards through the noise flow and accumulate brightness,
 * which reads as thousands of flowing particle streaks without any CPU-side
 * particle bookkeeping.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.palette}

${GLSL.simplex2d}
${GLSL.curl2d}

// Divergence-free flow from the shared library (issue #115). Two fixes over the
// hand-rolled version this replaces:
//
//   - it used value noise, which leaves axis-aligned lattice artifacts; on a
//     6000px-wide wall that grid is visible at normal viewing distance
//   - it added time as a scalar offset to *both* curl components, which slides
//     the whole field diagonally instead of evolving it. That is why the flow
//     visibly translated across the screen rather than churning in place.
vec2 flow(vec2 p, float t) {
  return curl2d(p, t);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / res.y;
  // Time offset alone is not enough: the noise field is sampled at a fixed
  // position, so a different phase gives the same field slid sideways. The
  // spatial offset below is what puts each activation in a different region.
  float t = iTime * 0.08 + iSeed.w * 12.0;

  vec2 fieldOffset = vec2(iSeed.x, iSeed.y) * 48.0;
  // Field scale varies, so streaks are coarser or finer per activation.
  float fscale = 1.6 + iSeed.z * 0.9;
  vec2 p = uv * 2.0 + fieldOffset;
  float bright = 0.0;
  // Integrate the streamline backwards along a fixed ARC of the flow, in STEPS
  // samples.
  //
  // WHY STEPS IS 16 AND NOT 40
  //
  // Each sample costs four snoise calls, because curl2d() takes the curl by
  // central differences. At 40 steps that is 160 noise evaluations per pixel --
  // about 1.2 billion per frame at 6000x1200 -- and this saver measured 15.6 fps
  // there, the slowest of all thirty (#225).
  //
  // ARC is held at the original 40 x 0.012, so the streamline traced is exactly
  // the same length through exactly the same field; it is integrated more
  // coarsely, not shortened. The brightness weight is ARC/STEPS for the same
  // reason, so accumulated brightness is unchanged and the streak curve and bloom
  // threshold below stay valid without retuning.
  //
  // A cheaper flow() was tried first and rejected. snoised() in the shared
  // library returns a value and its exact analytic gradient in one call, and the
  // curl of a scalar potential is that gradient rotated a quarter turn -- one
  // evaluation instead of four. It reached 40 fps, but it is the curl of a single
  // 3D potential, whereas curl2d samples its two components in decorrelated
  // planes slid along different axes. That is not the same field: the streamlines
  // and the speed distribution both change, and the frame lost its blacks (p05
  // 0.078 against 0.008, 8.9% of the frame below 0.15 against 36.6%). Recovering
  // the floor by retuning the speed ramp got p05 and the median back but not the
  // deep shadow, and the image still read as marbling rather than filaments on
  // black. #119 asks for this saver to get cheaper, NOT to be restyled, so the
  // field stays exactly as it was and only the sample count moves.
  const int STEPS = 16;
  const float ARC = 0.48;
  const float STEP = ARC / float(STEPS);
  // Carried out of the loop for the hue below, which used to spend a 17th flow()
  // call -- four more noise evaluations -- on a value the last iteration had
  // already computed.
  vec2 v = vec2(0.0);
  for (int i = 0; i < STEPS; i++) {
    v = flow(p * fscale, t);
    p -= v * STEP;
    // Brightness from how aligned the local flow is + a moving phase.
    float speed = length(v);
    bright += STEP * smoothstep(0.0, 1.5, speed);
  }

  // Streak intensity. The exponent controls how much of the frame is lit and
  // the multiplier controls how hard the lit parts burn.
  //
  // This was pow(bright, 1.3) * 2.2, which was authored before the post chain
  // existed (#112) and went straight to an 8-bit framebuffer with no encode.
  // Feeding those same values through the chain's sRGB encode lifts them a
  // second time -- a linear 0.02 background displays at 0.126, and the dense
  // mid-tones at 0.16 land near 0.52, so the dark gaps between filaments fill
  // in and the whole field reads as washed-out grey rather than glowing
  // filaments on black. Same class of bug as the raymarch double-encode in
  // #140, milder because it is gamma only and not gamma plus tonemap.
  //
  // A steeper exponent darkens everything below the filament cores, which is
  // what restores the black background; the higher multiplier keeps the cores
  // as bright as they were. Measured across a sweep, displayed values after
  // the chain's ACES + sRGB:
  //
  //   pow 1.3 x2.2 (original): p05 0.126, 0% of frame below 0.15
  //   pow 2.4 x6.5           : p05 0.034, 25%
  //   pow 4.0 x26.0 (this)   : p05 0.007, 37%
  //
  // The background is genuinely black again and filament peaks are unchanged
  // (p95 rises slightly). The median is still 0.34, so this is a substantial
  // improvement rather than a complete cure -- a saver authored against the
  // chain from the start would spend fewer pixels in the mid-tones.
  float streak = pow(bright, 4.0) * 26.0;
  // Hue cycles along the flow direction and time, reusing the last step's vector.
  vec2 vdir = v;
  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  float hue = atan(vdir.y, vdir.x) / 6.2831 + 0.5 + 0.05 * iTime;
  vec3 col = palettePerceptual(hue, phase);
  col *= streak;

  // Subtle dark vignette.
  col *= 1.0 - 0.4 * dot(uv, uv);
  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Flow Field', SHADER, {
  // Glow-oriented by design: bright filaments over a dark field, and #112
  // lists it among the savers that should have had bloom all along.
  //
  // 0.95 is ~70% of the measured scene peak (1.354). The previous 0.27 was set
  // against the old flatter streak curve, whose peak was 0.379; against the
  // steeper curve it selects a fifth of the peak, blooming most of the field
  // and filling the dark gaps between filaments -- undoing the fix above.
  postFX: { bloom: { threshold: 0.95, knee: 0.35, intensity: 0.28, radius: 0.9 } }
})
