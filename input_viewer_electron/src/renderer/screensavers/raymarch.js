// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Raymarched fractal — a slowly morphing Mandelbulb-ish distance field,
 * lit and orbited by the camera. Heavy GPU; looks great on discrete cards.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.palette}

// Mandelbulb distance estimator.
float de(vec3 pos, float power) {
  vec3 z = pos;
  float dr = 1.0;
  float r = 0.0;
  for (int i = 0; i < 8; i++) {
    r = length(z);
    if (r > 2.0) break;
    float theta = acos(z.z / r);
    float phi = atan(z.y, z.x);
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    float zr = pow(r, power);
    theta *= power;
    phi *= power;
    z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta));
    z += pos;
  }
  return 0.5 * log(r) * r / dr;
}

vec3 calcNormal(vec3 p, float power) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    de(p + e.xyy, power) - de(p - e.xyy, power),
    de(p + e.yxy, power) - de(p - e.yxy, power),
    de(p + e.yyx, power) - de(p - e.yyx, power)
  ));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / res.y;

  // Mandelbulb exponent sweep, entering at a random phase so the bulb's
  // morphology at activation differs. Range kept within 4..8 -- below 3 the
  // surface loses its lobed structure, above ~9 the detail outruns the fixed
  // march budget and produces acne.
  float powBase = 5.5 + iSeed.x * 1.2;
  float power = powBase + 2.0 * sin(iTime * 0.2 + iSeed.y * 6.2831);

  // Orbiting camera. The azimuth offset is the key variation: previously the
  // camera always started at exactly (2.4, 0, 0), so every activation opened on
  // the identical view of the fractal.
  float a = iTime * 0.15 + iSeed.z * 6.2831;
  // Orbit radius varies slightly, changing how much of the frame the bulb fills.
  float radius = 2.25 + iSeed.w * 0.45;
  vec3 ro = vec3(radius * cos(a), 0.6 * sin(iTime * 0.1 + iSeed.w * 6.2831), radius * sin(a));
  vec3 target = vec3(0.0);
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(uv.x * right + uv.y * up + 1.6 * fwd);

  float t = 0.0;
  float glow = 0.0;
  bool hit = false;
  vec3 p = ro;
  for (int i = 0; i < 90; i++) {
    p = ro + rd * t;
    float d = de(p, power);
    glow += 0.012 * (1.0 / (1.0 + d * 40.0));
    if (d < 0.0006) { hit = true; break; }
    if (t > 8.0) break;
    t += d * 0.85;
  }

  vec3 col = vec3(0.0);
  if (hit) {
    vec3 n = calcNormal(p, power);
    // Light azimuth varies; elevation stays high so the bulb is never lit
    // flatly from behind, which would silhouette it into near-blackness.
    float la = iSeed.y * 6.2831;
    vec3 lightDir = normalize(vec3(cos(la), 0.9, sin(la)));
    float diff = max(dot(n, lightDir), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
    vec3 base = palettePerceptual(length(p) * 0.6 + 0.05 * iTime, phase);
    col = base * (0.2 + diff) + fres * vec3(0.4, 0.6, 1.0);
  }
  // Volumetric-ish glow toward the fractal surface.
  col += glow * vec3(0.5, 0.7, 1.0);
  // Tone map + gamma.
  col = col / (1.0 + col);
  col = pow(col, vec3(0.4545));
  fragColor = vec4(col, 1.0);
}
`

// 4x supersampling (issue #116). This saver is the worst aliasing case in the
// set: a hard fractal silhouette with no multi-sampling and no distance-based
// edge softening, and the noisy DE edges shimmer frame to frame as the camera
// orbits. The context's antialias flag does nothing here -- MSAA samples
// polygon edges, and a fullscreen shader has none.
export default createShaderScreensaver('Raymarch Fractal', SHADER, { antialias: 4 })
