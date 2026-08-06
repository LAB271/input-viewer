// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Burning Ship — the Burning Ship fractal with an endless auto-zoom tour into
 * the iconic "ship" antenna detail, with smooth coloring.
 *
 * Iteration is like the Mandelbrot but takes the absolute value of the real
 * and imaginary parts before squaring:
 *   z = (|Re z| + i|Im z|)^2 + c
 *
 * Per-activation variation (iSeed): the zoom target is picked from five detail
 * regions, with varying zoom rate/depth and a rotated warm palette.
 */
import { createShaderScreensaver } from './gl-base.js'

const SHADER = /* glsl */ `
// Warm "burning" palette. Built from a cosine gradient rather than the
// monotonic smoothstep ramp this used to use: the input is wrapped with
// fract(), and a monotonic ramp under fract() has a hard discontinuity at the
// wrap point -- a visible colour seam that swept through the image as time
// advanced (see #123). A cosine palette is periodic by construction, so it
// wraps seamlessly, and it lets highlights actually reach white.
vec3 palette(float t, float rot) {
  vec3 phase = vec3(0.0, 0.12, 0.26) + rot;
  vec3 c = 0.5 + 0.5 * cos(6.2831 * (t + phase));
  // Weight toward reds/oranges so it still reads as fire rather than rainbow.
  return c * vec3(1.0, 0.72, 0.45) + vec3(0.0, 0.0, 0.05);
}

// Detail regions along the ship and its antennae, all of which hold structure
// under zoom.
vec2 zoomTarget(float s) {
  if (s < 0.2) return vec2(-1.7549,  -0.0286);  // antenna detail (original)
  if (s < 0.4) return vec2(-1.7433,  -0.0182);  // antenna fork
  if (s < 0.6) return vec2(-1.5810,  -0.0175);  // second ship
  if (s < 0.8) return vec2(-1.9411,  -0.0048);  // far antenna
  return vec2(-1.7269,  -0.0393);               // mast junction
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / res.y;

  // Smooth in/out zoom toward a detailed point on the main ship's antenna.
  // Depth capped at 3.4 -- past roughly exp(3.5) the 32-bit float precision
  // here breaks down into visible blocking.
  float rate = 0.10 + iSeed.z * 0.07;
  float depth = 2.8 + iSeed.w * 0.6;
  float zt = iTime * rate;
  float zoom = exp(0.5 + depth * (0.5 - 0.5 * cos(zt)));
  vec2 center = zoomTarget(iSeed.x);

  vec2 c = center + uv / zoom;

  vec2 z = vec2(0.0);
  const float MAX_I = 256.0;
  float i = 0.0;
  for (float n = 0.0; n < MAX_I; n++) {
    // Burning ship: abs the components before squaring.
    z = abs(z);
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { i = n; break; }
    i = n;
  }

  vec3 col;
  if (dot(z, z) <= 256.0) {
    col = vec3(0.0);
  } else {
    float sn = i - log2(log2(dot(z, z))) + 4.0;
    float t = fract(sn * 0.025 + iTime * 0.04);
    col = palette(t, iSeed.y);
    col *= 0.7 + 0.4 * sin(sn * 0.2);
  }
  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Burning Ship', SHADER, { antialias: 4 })
