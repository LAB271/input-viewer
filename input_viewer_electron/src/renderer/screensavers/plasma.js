// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Plasma — flowing colorful domain-warped fractal noise.
 * Smooth, hypnotic, cheap-to-mid GPU cost.
 *
 * Per-activation variation (iSeed): the noise field is offset to a different
 * region, the warp phases differ, the palette is rotated, and the two tint
 * colours are drawn from a curated set. Without the field offset alone the
 * saver would still open on the same patch of noise every time -- iTime starts
 * at 0, so the warp phase cannot vary on its own.
 */
import { createShaderScreensaver } from './gl-base.js'

const SHADER = /* glsl */ `
// Hash / value-noise building blocks
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

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Two tint colours per activation, drawn from complementary-ish pairs so the
// result stays a deliberate two-tone rather than a random muddy mix.
vec3 tintA(float s) {
  if (s < 0.25) return vec3(0.10, 0.20, 0.60); // blue (original)
  if (s < 0.50) return vec3(0.05, 0.35, 0.30); // teal
  if (s < 0.75) return vec3(0.35, 0.08, 0.45); // violet
  return vec3(0.08, 0.28, 0.55);               // steel
}

vec3 tintB(float s) {
  if (s < 0.25) return vec3(0.90, 0.40, 0.10); // orange (original)
  if (s < 0.50) return vec3(0.95, 0.75, 0.20); // gold
  if (s < 0.75) return vec3(0.85, 0.25, 0.35); // rose
  return vec3(0.60, 0.85, 0.40);               // lime
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // Offset into the noise field. This is the part that actually varies the
  // opening frame: iTime starts at 0 on every activation, so without a spatial
  // offset every run begins on the same patch of fbm.
  vec2 fieldOffset = vec2(iSeed.x, iSeed.y) * 64.0;
  // Scale varies mildly -- enough to change the sense of scale, not enough to
  // turn the plasma into either flat wash or fine noise.
  float scale = 2.4 + iSeed.z * 1.4;
  vec2 p = uv * scale + fieldOffset;

  // Phase offsets so the warp does not start from the same configuration.
  float t = iTime * 0.15 + iSeed.w * 20.0;

  // Domain warping: feed fbm into fbm.
  vec2 q = vec2(fbm(p + vec2(0.0, 0.0) + t),
                fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(p + 4.0 * q + vec2(8.3, 2.8) - 0.12 * t));
  float f = fbm(p + 4.0 * r);

  // Color palette (cosine gradient), rotated per activation.
  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (f + phase + 0.1 * iTime));
  col = mix(col, tintA(iSeed.y), clamp(length(q), 0.0, 1.0));
  col = mix(col, tintB(iSeed.z), clamp(r.x * r.x, 0.0, 1.0));
  col *= 0.7 + 0.6 * f;

  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Plasma', SHADER)
