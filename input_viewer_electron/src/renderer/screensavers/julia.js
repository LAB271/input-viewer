// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Julia set — continuously morphing c-parameter traces a path through
 * parameter space, so the fractal shape constantly evolves.
 *
 * Per-activation variation (iSeed): the Lissajous path starts at a random phase
 * and is pulled toward one of six classic c values, with a varying view scale
 * and palette rotation. The phase offset is the important one -- both sinusoids
 * previously started at phase 0, so every activation opened on the identical
 * Julia shape and morphed through the identical sequence.
 */
import { createShaderScreensaver } from './gl-base.js'

const SHADER = /* glsl */ `
vec3 palette(float t, vec3 phase) {
  return 0.5 + 0.5 * cos(6.2831 * (t + phase));
}

// Classic c values, each a visually distinct Julia morphology. Curated for the
// same reason as the Mandelbrot targets: most of the complex plane gives either
// a solid disc or a disconnected dust, neither of which is worth watching.
vec2 anchorC(float s) {
  if (s < 0.1667) return vec2(-0.800,  0.156);  // classic (original)
  if (s < 0.3333) return vec2(-0.400,  0.600);  // dendrite
  if (s < 0.5000) return vec2( 0.285,  0.010);  // near-parabolic spiral
  if (s < 0.6667) return vec2(-0.123,  0.745);  // Douady rabbit
  if (s < 0.8333) return vec2(-0.750,  0.110);  // san marco variant
  return vec2(-0.170,  0.657);                  // Siegel disk
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  // Mild framing variation, kept close to 1.6 so the set still fills the frame.
  float view = 1.45 + iSeed.z * 0.35;
  vec2 uv = (fragCoord - 0.5 * res) / res.y * view;

  // Animate c along a smooth Lissajous-like path near the boundary, entering
  // at a random phase so the opening shape differs per activation.
  float ph = iSeed.x * 6.2831;
  float t = iTime * 0.12 + ph;
  vec2 c = vec2(0.7885 * cos(t * 1.3), 0.7885 * sin(t * 0.9));
  // Pull it toward a classic interesting value.
  c = mix(c, anchorC(iSeed.y), 0.3 + 0.3 * sin(t * 0.5));

  vec2 z = uv;
  const float MAX_I = 256.0;
  float i = 0.0;
  for (float n = 0.0; n < MAX_I; n++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { i = n; break; }
    i = n;
  }

  vec3 col;
  if (dot(z, z) <= 256.0) {
    col = vec3(0.02, 0.0, 0.05);
  } else {
    float sn = i - log2(log2(dot(z, z))) + 4.0;
    vec3 phase = vec3(0.0, 0.40, 0.75) + iSeed.w;
    col = palette(sn * 0.025 + iTime * 0.04, phase);
    // Banding keyed on iteration count only. The previous form added raw iTime
    // here, which modulated the *whole frame* at ~0.16 Hz -- a full-screen
    // brightness pulse that reads as a fault on a large display (see #122).
    col *= 0.5 + 0.5 * sin(sn * 0.25);
  }
  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Julia Set', SHADER, { antialias: 4 })
