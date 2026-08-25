// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Julia Family — a slice through parameter space, drawn as the family of Julia
 * sets along it (#209).
 *
 * Replaces the separate Julia Set and Mandelbrot entries. Every Julia set is
 * defined by one complex parameter `c`, and the Mandelbrot set is the map of which
 * `c` give a connected Julia set. This shows a row of Julia sets whose `c` values
 * step across a short line in that map, centred on the boundary — so the row spans
 * the connected/dust transition and you can watch it sweep across the wall as the
 * centre travels.
 *
 * ## Composition: option C, and what it cost
 *
 * #209 offered three compositions and the choice was C, "c varies with horizontal
 * position". Taken literally that does not work: a Julia set needs both dimensions
 * of the z-plane, so varying `c` per pixel column leaves one vertical line per set
 * and the frame is a smear. C is therefore built as BANDS — one complete Julia set
 * per band, `c` stepping band to band. On 5:1 that is five 1200x1200 squares, which
 * is the aspect a Julia set wants anyway.
 *
 * ## Why this does not use the perturbation dive
 *
 * #209 also asked for "dive with a following Julia", to keep #121's infinite-zoom
 * work. Under composition C it cannot be kept, and the reason is arithmetic:
 *
 * A Julia iteration is z^2 + c with |z| about 2, so `c` is ADDED to an O(1) value
 * every step. At a 2^80 dive the band `c` values differ by ~1e-24; in float32 they
 * are indistinguishable from each other and from their shared base, so all bands
 * would render the identical set from roughly the 17th doubling onward. Recovering
 * the depth needs perturbation theory per band — one CPU reference orbit each —
 * which is far more than this issue scopes.
 *
 * So the window here is floored at a width float32 renders honestly (see
 * WINDOW_RANGE), and what #121 contributes is its curated boundary TARGETS rather
 * than its machinery. Those targets came from an offline boundary descent, which is
 * exactly the property this needs: a window centred on one straddles the boundary,
 * which is what makes the connected-to-dust transition appear at all.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

/**
 * Width of the c-window, as a range it breathes between.
 *
 * The floor is not a taste decision. Below about 1e-6 the difference between
 * adjacent bands' `c` disappears into float32 when added to z^2, and the family
 * collapses to one repeated set. 0.02 is four orders of magnitude clear of that, so
 * the arithmetic is never the limit; the range is chosen for how different the
 * morphologies look.
 *
 * At 0.02 the bands are variations on one shape. At 0.18 they are distinct
 * morphologies and the window reaches well past the boundary, so the outer bands
 * are dust while the inner ones are connected.
 */
const WINDOW_RANGE = [0.02, 0.18]

const SHADER = /* glsl */ `${GLSL.palette}

vec3 pal(float t, vec3 phase) {
  return palettePerceptual(t, phase);
}

// Boundary waypoints, from #121's offline descent (its DIVE_TARGETS, high words).
//
// Only the high word survives here, which is all float32 carries -- a consistency
// with the precision note in the header rather than a loss: these are used as
// centres for a 0.02-0.18 wide window, so 1e-17 of extra mantissa would round away
// regardless.
//
// Every one sits ON the boundary, which is the point: a window centred here has
// connected sets on one side and dust on the other.
vec2 waypoint(int i) {
  if (i == 0) return vec2(-0.650184794685523,  0.353055535780441);
  if (i == 1) return vec2(-0.698213700924294,  0.258982688816176);
  if (i == 2) return vec2(-1.047061989001585, -0.247016285343538);
  if (i == 3) return vec2(-1.336337945564129, -0.052729299598222);
  if (i == 4) return vec2(-0.294091172818190,  0.645193540195812);
  return              vec2(-0.645509523133210, -0.363403402937936);
}

const int WAYPOINTS = 6;

// Seconds spent travelling between one waypoint and the next.
//
// Long, because the interesting thing is slow: the window crossing the boundary as
// the centre moves. A ten-minute no-signal slot covers about seven legs, so several
// connected-to-dust sweeps happen within one activation (#209 asks for at least one).
const float LEG_SECONDS = 84.0;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;

  // How many bands fit, as whole squares. 5 on the 6000x1200 wall, 2 on 16:9, 1 on
  // anything squarer -- a single Julia set rather than a stretched pair.
  float bands = clamp(floor(res.x / res.y + 0.5), 1.0, 6.0);
  float bandW = res.x / bands;
  float bandIndex = clamp(floor(fragCoord.x / bandW), 0.0, bands - 1.0);

  // A gutter, so the row reads as a deliberate contact sheet rather than as tearing.
  // #92 is the precedent: an abstract seam on a large display reads as a fault.
  float gutterPx = max(2.0, res.y * 0.004);
  vec2 inBand = vec2(fragCoord.x - bandIndex * bandW, fragCoord.y);
  if (inBand.x < gutterPx || inBand.x > bandW - gutterPx) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // z-plane coordinates within this band's own square.
  float side = min(bandW, res.y);
  float view = 1.45 + iSeed.z * 0.35;
  vec2 uv = (inBand - 0.5 * vec2(bandW, res.y)) / side * view;

  // Where the centre of the window is: a slow walk between waypoints, entered at a
  // random leg and phase so activations differ.
  float t = iTime / LEG_SECONDS + iSeed.x * float(WAYPOINTS);
  int leg = int(mod(floor(t), float(WAYPOINTS)));
  int next = int(mod(floor(t) + 1.0, float(WAYPOINTS)));
  float f = fract(t);
  // Smoothstep rather than linear, so the centre eases in and out of each waypoint
  // and lingers where the structure is richest.
  vec2 centre = mix(waypoint(leg), waypoint(next), smoothstep(0.0, 1.0, f));

  // The window breathes, and rotates, so the slice is not always the same cut.
  float breathe = 0.5 + 0.5 * sin(iTime * 0.031 + iSeed.y * 6.2831);
  float width = mix(${WINDOW_RANGE[0].toFixed(3)}, ${WINDOW_RANGE[1].toFixed(3)}, breathe);
  float ang = iTime * 0.017 + iSeed.w * 6.2831;
  vec2 dir = vec2(cos(ang), sin(ang));

  // This band's c: centred on the walk, offset along the slice.
  float s = bands > 1.0 ? (bandIndex + 0.5) / bands - 0.5 : 0.0;
  vec2 c = centre + dir * (s * width);

  vec2 z = uv;
  const float MAX_I = 320.0;
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
    col = pal(sn * 0.025 + iTime * 0.04, phase);
    // Banding on iteration count only. Adding raw iTime here modulates the whole
    // frame, which reads as a fault on a large display (#122).
    col *= 0.5 + 0.5 * sin(sn * 0.25);
    // Fade the far exterior to black.
    //
    // Without this, points that escape immediately still take a full palette colour,
    // so the background is a flat saturated field -- measured at 6000x1200 the frame
    // was largely bright orange with the sets sitting on top of it. That is the worst
    // case for the 12% washout this has to survive, and it leaves bloom nothing to
    // pick out: everything is bright, so nothing glows.
    //
    // Ramping brightness with escape time puts the light where the structure is --
    // dark exterior, bright filigree along the boundary, which is both the classic
    // rendering and the one that holds up in a lit room.
    col *= smoothstep(0.0, 14.0, sn);
  }

  // Hand LINEAR light to the post chain, which sRGB-encodes what it receives.
  // Carried over from julia.js: without this the background washes out to grey,
  // the same double-encode as #140.
  col = pow(max(col, 0.0), vec3(2.2));

  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Julia Family', SHADER, {
  antialias: 4,
  // Inherited from julia.js, whose scene peak this shader's colour path matches --
  // the palette, banding and linearisation are unchanged, so the measured 0.248 peak
  // and its 70% threshold still apply.
  postFX: { bloom: { threshold: 0.17, knee: 0.3, intensity: 0.3, radius: 0.8 } }
})
