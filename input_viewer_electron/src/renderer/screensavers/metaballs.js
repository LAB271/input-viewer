// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Metaballs — lava-lamp blobs whose summed implicit field is shaded, so they
 * bulge toward each other and merge and split organically (issue #99).
 *
 * Pure fragment shader with no simulation state: the blobs move on closed-form
 * paths evaluated from iTime, so nothing is uploaded per frame and start/stop
 * is free. The CPU-uniform approach the issue sketches would work equally well,
 * but the motion here is simple enough to express analytically, and that keeps
 * the whole saver inside one shader.
 *
 * Per-activation variation (iSeed): overall blob scale, the time origin, the
 * palette rotation and the rim/background tints all shift. The blob count and
 * the per-blob path constants are fixed (hashed from the blob index), which is
 * deliberate -- the paths are already quasi-periodic, so varying the time
 * origin is what makes an activation look different. iTime resets to 0 on every
 * start(), so without that offset every run would open on the same frame.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

// 10 blobs. The field is summed per pixel, so cost is linear in this; 8-12 is
// the range where the merging still reads as deliberate rather than as soup.
const BLOB_COUNT = 10

const SHADER = /* glsl */ `${GLSL.worldSpace}
${GLSL.palette}
${GLSL.hash}

// One blob's position at time t. Each traces a Lissajous path with its own
// frequency pair and phase, which gives quasi-periodic drift -- the blobs never
// settle into a visibly repeating formation the way a shared frequency would.
vec2 blobPos(int i, float t, vec2 halfExtent) {
  float fi = float(i);
  // Uncorrelated per-blob constants from the shared integer hash, so these are
  // stable across frames without needing a uniform upload. Each call gets a
  // distinct input so the four values do not correlate with each other.
  float fx = 0.055 + rand(fi * 7.13 + 1.7) * 0.075;
  float fy = 0.048 + rand(fi * 3.91 + 9.2) * 0.082;
  float px = rand(fi * 5.77 + 2.3) * 6.2831;
  float py = rand(fi * 2.19 + 8.6) * 6.2831;

  // Inset from the edge by the blob's own reach so a blob never sits half
  // off-screen, which would read as a hard clip rather than a soft blob.
  vec2 amp = halfExtent * 0.72;
  return vec2(amp.x * sin(t * fx * 6.2831 + px),
              amp.y * cos(t * fy * 6.2831 + py));
}

// Per-blob radius. Varying these matters: equal radii make the merges look
// mechanical, and the size contrast is most of what sells the lava-lamp look.
float blobRadius(int i, float scale) {
  return scale * (0.055 + rand(float(i) * 5.37 + 4.1) * 0.075);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World space -- divide by the short axis (issue #114). This is THE bug the
  // issue warns about: computing distances in normalised [0,1] coordinates
  // makes every blob an ellipse stretched 5:1 on the 6000x1200 wall, and it is
  // completely invisible in a 16:10 preview window.
  vec2 uv = worldFromFrag(fragCoord, iResolution.xy);
  float aspect = iResolution.x / iResolution.y;
  vec2 halfExtent = vec2(0.5 * aspect, 0.5);

  // Global scale and time offset vary per activation.
  float scale = 0.85 + iSeed.z * 0.5;
  float t = iTime + iSeed.w * 120.0;

  // Sum the classic inverse-square field. The +eps is not optional: at a blob
  // centre dist2 is 0 and the field would divide by zero, producing a NaN that
  // propagates through the shading and shows up as a black or white dot.
  const float EPS = 1e-4;
  float field = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < ${BLOB_COUNT}; i++) {
    vec2 c = blobPos(i, t, halfExtent);
    float r = blobRadius(i, scale);
    vec2 d = uv - c;
    float dist2 = dot(d, d) + EPS;
    float contrib = (r * r) / dist2;
    field += contrib;
    // Field gradient, accumulated analytically. Used for shading below --
    // cheaper and cleaner than sampling the field at neighbouring pixels.
    grad += -2.0 * contrib * d / dist2;
  }

  // Power curve before mapping to colour. The raw summed field looks flat; the
  // issue notes ~2.2 from the prototype, and that holds up -- it is what gives
  // the soft shoulder at the blob edge instead of a linear ramp. A hard
  // threshold (step) is the other valid choice, but gives crisp cell shapes
  // rather than the soft lava-lamp surface wanted here.
  float shaped = pow(clamp(field, 0.0, 4.0) * 0.42, 2.2);
  float mask = clamp(shaped, 0.0, 1.0);

  // Palette driven by the field, so merging blobs shift hue where they overlap
  // and the necks between them read as a distinct colour rather than a seam.
  vec3 phase = vec3(0.0, 0.33, 0.67) + iSeed.x;
  vec3 col = palettePerceptual(0.15 + field * 0.22 + 0.02 * t, phase);

  // Fake lighting from the field gradient: the surface normal of an implicit
  // surface is its gradient, so this gives the blobs volume for free.
  vec2 n = normalize(grad + vec2(1e-6));
  float lambert = 0.5 + 0.5 * dot(n, normalize(vec2(-0.55, 0.8)));
  col *= 0.55 + 0.65 * lambert;

  // Rim highlight where the field is near the surface threshold, which reads as
  // the meniscus on a real lava lamp.
  float rim = smoothstep(0.35, 0.72, mask) * (1.0 - smoothstep(0.72, 0.98, mask));
  col += rim * 0.35 * palettePerceptual(0.55 + iSeed.y, phase);

  // Dim background wash rather than pure black. Per issue #88 a dim-on-black
  // saver loses badly to ambient light on the projector wall, and the blobs
  // need something to sit against at 12% washout.
  vec3 bg = palettePerceptual(0.72 + iSeed.y, phase) * 0.07;

  fragColor = vec4(mix(bg, col, mask), 1.0);
}
`

// Bloom on the blob surfaces. Threshold set from the saver's measured peak
// rather than by analogy: this is an LDR fragment saver whose measured peak is
// 0.539, so 0.38 is roughly 70% of it. An earlier 0.55 was above the peak
// entirely and bloomed nothing at all -- silently, since a bright pass that
// selects no pixels still renders fine. See the HDR-vs-LDR note in post-fx.js;
// that is the same trap that caught #112.
export default createShaderScreensaver('Metaballs', SHADER, {
  postFX: { bloom: { threshold: 0.38, knee: 0.3, intensity: 0.3, radius: 0.85 } }
})
