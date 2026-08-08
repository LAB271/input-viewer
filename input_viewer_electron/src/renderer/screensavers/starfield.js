// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Starfield warp — flying forward through a field of stars, each streaking
 * outward from the vanishing point (issue #58).
 *
 * Pure fragment shader with no state. Stars live in a set of depth layers; a
 * layer's stars are placed by hashing a cell index, and their screen position
 * is that placement divided by a depth that decreases with iTime. When a layer
 * passes the camera it wraps and re-hashes, so the field is endless without
 * storing anything.
 *
 * This one suits the 5:1 wall particularly well: the motion is radial from the
 * centre, so a wide canvas means stars spend longer streaking across it rather
 * than exiting immediately, which is what sells the sense of speed.
 *
 * Per-activation variation (iSeed): warp speed, star density, the vanishing
 * point offset, and the colour temperature spread across the field.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

// Depth layers. Each is a full grid of candidate stars at one depth; more
// layers means a denser field at a linear cost, since every layer is evaluated
// per pixel. 14 is where the field looks continuous without the shader getting
// expensive at 6000x1200.
const LAYERS = 14

const SHADER = /* glsl */ `${GLSL.worldSpace}
${GLSL.hash}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World space -- divide by the short axis so stars are round and the radial
  // motion is circular rather than elliptical on a 5:1 canvas (issue #114).
  vec2 uv = worldFromFrag(fragCoord, iResolution.xy);

  // Vanishing point drifts slowly off-centre, so the flight has a sense of
  // direction rather than being locked to the exact middle of the wall.
  vec2 centre = vec2(sin(iTime * 0.043 + iSeed.x * 6.28) * 0.06,
                     cos(iTime * 0.037 + iSeed.y * 6.28) * 0.04);
  vec2 p = uv - centre;

  float speed = mix(0.14, 0.34, iSeed.z);
  float t = iTime * speed + iSeed.w * 40.0;

  vec3 col = vec3(0.0);

  for (int i = 0; i < ${LAYERS}; i++) {
    float fi = float(i);

    // Depth of this layer, cycling in [0,1). Each layer is offset so they are
    // evenly spread through the tunnel instead of arriving in lockstep.
    float depth = fract(t + fi / float(${LAYERS}));

    // Re-hash on each wrap. floor() of the un-fracted value changes exactly
    // when the layer recycles, so a layer gets a fresh set of stars each pass
    // rather than repeating the same arrangement every cycle.
    float cycle = floor(t + fi / float(${LAYERS}));
    float layerId = fi * 37.0 + cycle * 131.0 + iSeed.x * 907.0;

    // A few stars per layer. Each is placed uniformly in a square around the
    // vanishing point, then projected by dividing through the depth.
    for (int j = 0; j < 3; j++) {
      float sid = layerId + float(j) * 17.3;
      vec2 place = vec2(rand(sid), rand(sid + 5.1)) - 0.5;
      // Reject stars too close to the centre line: divided by a small depth
      // they would shoot across the screen faster than the eye can follow and
      // read as flicker rather than motion.
      if (length(place) < 0.06) continue;

      // Perspective divide. depth near 0 means "at the camera", so the star is
      // far off-screen; depth near 1 is distant and close to the vanishing
      // point. The 0.02 floor keeps the divide bounded.
      float z = max(depth, 0.02);
      vec2 star = place / z * 0.5;

      // Previous position one short step back in time, used to draw the streak
      // as a segment rather than a point. This is what makes it a warp rather
      // than a starfield.
      float zPrev = max(depth + 0.045 * speed, 0.02);
      vec2 starPrev = place / zPrev * 0.5;

      // Distance from the pixel to the segment [starPrev, star].
      vec2 seg = star - starPrev;
      float segLen2 = max(dot(seg, seg), 1e-9);
      float h = clamp(dot(p - starPrev, seg) / segLen2, 0.0, 1.0);
      float d = length(p - (starPrev + seg * h));

      // Nearer stars are bigger and brighter. Both scale with 1/z, which is
      // what gives the field its depth cue.
      float size = mix(0.0009, 0.0042, 1.0 - z);
      float bright = (1.0 - z) * (1.0 - z);

      // Fade in as the layer wraps, so stars do not pop into existence at full
      // brightness at the edge of the screen.
      float wrapFade = smoothstep(0.0, 0.12, depth) * smoothstep(1.0, 0.86, depth);

      // Soft round core, normalised so the size term actually controls the star.
      //
      // The obvious form, size / (d*d + size*k), looks right but is wrong: at
      // the core (d = 0) it evaluates to 1/k for EVERY star, so size cancels
      // out completely -- all stars peak identically and the depth cue is
      // carried only by the bright term. Measured peak was 0.036 across the
      // whole frame. Squaring size instead keeps the near-field falloff while
      // letting a nearer (larger) star genuinely burn brighter at its centre.
      float glow = (size * size) / (d * d + size * size * 0.22);

      // Colour temperature per star: mostly white, some warm, some blue. A
      // pure-white field looks flat, and this is cheap.
      float temp = rand(sid + 11.7);
      vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.78, 0.88, 1.0),
                      smoothstep(0.35, 0.75, temp));
      tint = mix(vec3(1.0), tint, 0.55);

      // Scale chosen so a near star's core lands slightly above 1.0 in the
      // HDR target, which is what gives the bloom something to work with.
      col += tint * glow * bright * wrapFade * 0.30;
    }
  }

  // Very dim blue-black background. Pure black loses the field entirely under
  // ambient light on the projector wall (issue #88).
  col += vec3(0.012, 0.014, 0.026);

  fragColor = vec4(col, 1.0);
}
`

// Bloom on the star cores. Stars are small and very bright against near-black,
// which is the ideal case for a bright pass. 0.62 is roughly 70% of the
// measured peak (0.91) -- set from the measurement, not by analogy, per the
// HDR-vs-LDR note in post-fx.js.
export default createShaderScreensaver('Starfield Warp', SHADER, {
  postFX: { bloom: { threshold: 0.62, knee: 0.3, intensity: 0.5, radius: 0.95 } }
})
