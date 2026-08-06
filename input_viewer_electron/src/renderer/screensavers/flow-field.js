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

const SHADER = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 2D curl of a scalar noise field -> divergence-free flow.
vec2 flow(vec2 p, float t) {
  float e = 0.05;
  float n1 = noise(p + vec2(0.0, e) + t);
  float n2 = noise(p - vec2(0.0, e) + t);
  float n3 = noise(p + vec2(e, 0.0) - t);
  float n4 = noise(p - vec2(e, 0.0) - t);
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
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
  // Integrate the streamline backwards a few steps.
  for (int i = 0; i < 40; i++) {
    vec2 v = flow(p * fscale, t);
    p -= v * 0.012;
    // Brightness from how aligned the local flow is + a moving phase.
    float speed = length(v);
    bright += 0.012 * smoothstep(0.0, 1.5, speed);
  }

  float streak = pow(bright, 1.3) * 2.2;
  // Hue cycles along the flow direction and time.
  vec2 vdir = flow(p * fscale, t);
  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  float hue = atan(vdir.y, vdir.x) / 6.2831 + 0.5 + 0.05 * iTime;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (hue + phase));
  col *= streak;

  // Subtle dark vignette.
  col *= 1.0 - 0.4 * dot(uv, uv);
  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Flow Field', SHADER)
