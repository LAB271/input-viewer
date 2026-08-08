// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Mandelbrot — endless auto-zoom tour into the set with smooth coloring.
 *
 * The camera continuously zooms toward an interesting point and the palette
 * cycles, so it never needs interaction. Uses smooth (continuous) iteration
 * count to avoid banding.
 *
 * Per-activation variation (iSeed): the zoom target is picked from a set of
 * eight known-interesting boundary coordinates, the zoom depth and rate vary,
 * and the palette is rotated. Previously every activation toured the identical
 * coordinate from the identical wide shot -- the most conspicuous replay in the
 * whole set, since the destination was a single hardcoded point.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.palette}

vec3 palette(float t, vec3 phase) {
  return palettePerceptual(t, phase);
}

// Eight boundary points that stay detailed all the way down. Hand-picked
// rather than random: a randomly chosen complex coordinate is overwhelmingly
// likely to land either inside the set (flat black) or far outside it (flat
// background), so picking from a curated list is what keeps every activation
// worth watching.
vec2 zoomTarget(float s) {
  if (s < 0.125) return vec2(-0.74364388703,  0.13182590421); // seahorse valley
  if (s < 0.250) return vec2(-0.7436447860,   0.1318252536);  // deeper seahorse
  if (s < 0.375) return vec2(-0.10109636384,  0.95628651080); // spiral filament
  if (s < 0.500) return vec2(-1.25066,        0.02012);       // west antenna
  if (s < 0.625) return vec2(-0.16070135,     1.03775200);    // north bulb edge
  if (s < 0.750) return vec2( 0.28693186889,  0.01430197560); // east elephant
  if (s < 0.875) return vec2(-1.74995768,     0.00000000);    // needle tip
  return vec2(-0.7345,  0.1975);                              // triple spiral
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / res.y;

  // Zoom oscillates in and back out so the tour loops smoothly. Rate and depth
  // both vary, so runs differ in pace as well as destination. Depth is capped
  // at 3.4 because 32-bit floats break down past roughly exp(3.5) here.
  float rate = 0.11 + iSeed.z * 0.09;
  float depth = 2.6 + iSeed.w * 0.8;
  float zt = iTime * rate;
  float zoom = exp(-2.0 + depth * (0.5 - 0.5 * cos(zt))); // smooth in/out
  vec2 center = zoomTarget(iSeed.x);

  vec2 c = center + uv / zoom;

  vec2 z = vec2(0.0);
  const float MAX_I = 256.0;
  float i = 0.0;
  for (float n = 0.0; n < MAX_I; n++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { i = n; break; }
    i = n;
  }

  vec3 col;
  if (dot(z, z) <= 256.0) {
    col = vec3(0.0); // inside the set
  } else {
    // Smooth iteration count.
    float sn = i - log2(log2(dot(z, z))) + 4.0;
    vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.y;
    col = palette(sn * 0.02 + iTime * 0.05, phase);
    col *= 0.6 + 0.4 * sin(sn * 0.3);
  }

  // Hand LINEAR light to the post chain.
  //
  // Everything above was authored before #112, when this saver rendered
  // straight to an 8-bit framebuffer with no encode -- so those values are
  // display-referred (a 0.6 here meant "display at 0.6"). The chain added by
  // #112 sRGB-ENCODES whatever it receives, which lifted them a second time:
  // measured displayed p05 was 0.645 with only 1%% of the frame dark, i.e. the
  // background washed out to grey. Same class of bug as the raymarch
  // double-encode in #140, gamma-only rather than gamma plus tonemap.
  //
  // pow(col, 2.2) inverts the encode the chain will apply, so the round trip
  // is exact and the pre-#112 look is restored -- while bloom and ACES now
  // operate on physically-linear values, which is what they expect.
  col = pow(max(col, 0.0), vec3(2.2));

  fragColor = vec4(col, 1.0);
}
`

// 4x supersampling (issue #116). Escape-time boundary filigree is the textbook
// aliasing case, and the auto-zoom means it moves, so it shimmers. Smooth
// iteration colouring already helps; this handles what it cannot.
export default createShaderScreensaver('Mandelbrot', SHADER, {
  antialias: 4,
  // Bloom on the bright boundary filigree, which is where all the detail is.
  // Threshold above the interior so the body of the set stays dark.
  // Threshold is ~70%% of the measured scene peak (0.709) now that the
  // shader hands over linear light. The previous 0.3 was set against the
  // pre-linearisation output, whose peak was higher.
  postFX: { bloom: { threshold: 0.5, knee: 0.3, intensity: 0.3, radius: 0.8 } }
})
