// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Plasma — a lit, eroded, domain-warped noise surface (issue #118).
 *
 * The previous version was 2D fBm coloured by a palette: correct, and a wall of
 * undifferentiated purple at 6000x1200. Four things were wrong and all four are
 * structural rather than a matter of taste:
 *
 *   1. The colour carried the high-frequency detail and the lightness was
 *      almost constant, so every pixel was the same value and the image had no
 *      shape. Eyes resolve luminance detail far better than chroma detail; put
 *      the fine structure in the wrong channel and it averages to mud at any
 *      distance. Here lightness carries the detail and hue varies only at very
 *      low frequency, in large zones.
 *   2. Nothing varied at large scale, so a 5:1 canvas showed the same texture
 *      5000 pixels wide with nowhere for the eye to rest. A slow, very
 *      low-frequency energy field now darkens whole stretches of the wall.
 *   3. It was flat. The fBm gradient is available analytically (#115), so the
 *      field is shaded as a heightfield with a key light and a specular — the
 *      same data, an order of magnitude more depth.
 *   4. Time was added to the 2D coordinate, which translates a field rather
 *      than evolving it, so it read as a texture scrolling past. Time is now
 *      the third axis of 3D noise and the pattern churns in place.
 *
 * Per-activation variation (iSeed): field offset (iTime starts at 0 every
 * activation, so without a spatial offset every run opens on the same patch),
 * feature scale, base hue, and the phase of the energy field.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.worldSpace}
${GLSL.palette}
${GLSL.simplex2d}
${GLSL.simplex3d}
${GLSL.fbmd3}

const float TAU = 6.28318530718;

// The analytic gradient of an fbmd3 octave is not a small number: simplex noise
// is normalised so its *value* lands in [-1,1], which leaves the derivative
// running around 5-10 per unit of input. Measured here (rendering
// length(n.yzw) directly) it sits near 8 for the octave counts below. Dividing
// by that lets every warp amplitude and bump strength further down be written
// as "how far, in cells" rather than as an opaque small constant, which is the
// difference between tuning and guessing.
const float GRAD_NORM = 1.0 / 8.0;

// Rotations applied to each warp level's flow vector.
//
// Rotating a gradient by 90 degrees in the xy plane turns it into a
// divergence-free flow: instead of pushing the domain downhill (which piles
// material up and flattens the result) it shears the domain sideways, which is
// what produces the marbled, filament-rich look. The two levels use different
// angles so the second warp does not simply reinforce the first.
mat3 flowRotation(float turns) {
  float a = TAU * turns;
  float c = cos(a), s = sin(a);
  // Rotation about z, with a slight tilt into z so the warp also displaces the
  // time axis -- neighbouring regions then evolve slightly out of step, which
  // stops the whole field pulsing as one.
  return mat3( c,  s, 0.0,
              -s,  c, 0.0,
              0.0, 0.12, 0.99);
}

// Base hues, in turns around the OKLab hue wheel. Curated rather than random:
// the interesting failure of a free hue is that it lands somewhere the sRGB
// gamut is narrow at this lightness, and the ramp flattens exactly where it
// should be most saturated. These four were checked against the L/C used below.
float baseHue(float s) {
  if (s < 0.25) return 0.62;  // deep blue -> cyan
  if (s < 0.50) return 0.08;  // amber -> magma
  if (s < 0.75) return 0.42;  // jade -> teal
  return 0.86;                // violet -> rose
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World space: divide by the SHORT axis, so the pattern is not stretched 5:1
  // on the wall (issue #114) and a wider canvas shows more plasma rather than a
  // magnified version of the same plasma. y spans [-0.5, 0.5].
  vec2 uv = worldFromFrag(fragCoord, iResolution.xy);

  // Base feature scale, in cells per screen height. Deliberately close to one:
  // in a domain-warped fBm the apparent complexity comes from the warp, not
  // from the base frequency, so the base stays large and soft. At 6000x1200
  // this is ~900px per base cell, and the wall shows about seven of them
  // across. The old version was effectively at 30+ cells per height with no
  // large-scale variation at all, which is precisely why it turned to mud.
  float scale = 1.05 + iSeed.z * 0.30;

  // Field offset. Also decorrelates the three fbm levels from each other.
  vec3 offset = vec3(iSeed.x, iSeed.y, iSeed.w) * 71.0;

  // Time on the third axis. 0.05 cells/second against a cell of 1.0 means the
  // surface renews itself over roughly twenty seconds -- slow enough to be calm
  // on a ten-minute rotation slot, fast enough that it is visibly alive.
  float t = iTime;
  vec3 p = vec3(uv * scale, t * 0.05) + offset;

  // ---- Multi-level domain warp -------------------------------------------
  // The warp vector at each level is the *derivative* of a low-octave fbm, so a
  // coherent flow direction costs one fbm rather than the two or three separate
  // noise fields the usual (Quilez) formulation evaluates. Few octaves and a
  // low gain on purpose: a warp field with fine detail in it displaces
  // neighbouring pixels in unrelated directions, which shreds the level below
  // into grain instead of stretching it into filaments.
  //
  // Displacement is comparable to the cell size at level 1 and a third of it at
  // level 2. That is the regime where fBm stops looking like clouds and starts
  // looking marbled -- much less and it is just fBm, much more and the domain
  // folds onto itself into pinched knots.
  vec4 n1 = fbmd3(p, 3, 0.42, 0.0);
  vec3 p1 = p + 0.90 * GRAD_NORM * (flowRotation(0.25) * n1.yzw);

  // Level 2 runs on the already-warped domain at a slightly higher frequency
  // and a different rotation, so it shears rather than reinforcing level 1.
  vec4 n2 = fbmd3(p1 * 1.6 + vec3(19.3, 7.1, t * 0.018), 3, 0.42, 0.0);
  vec3 p2 = p1 + 0.32 * GRAD_NORM * (flowRotation(-0.17) * n2.yzw);

  // Level 3: the surface itself. Gain 0.40 rather than 0.5 because the gradient
  // is about to be used for lighting -- see the note on fbmd3. Erosion damps
  // octaves where the accumulated slope is already steep, concentrating fine
  // detail into the flanks of the large forms instead of spreading it evenly;
  // 0.35 is moderate, higher flattens the ridges into plateaus.
  vec4 n3 = fbmd3(p2 + vec3(4.7, 11.9, 0.0), 4, 0.40, 0.35);
  float h = n3.x;
  vec2 grad = n3.yz;

  // ---- Lighting -----------------------------------------------------------
  // Shade the fBm as a heightfield. This is the cheapest depth available: the
  // gradient is already computed, and the difference between a colour-mapped
  // plasma and a lit one is the difference between a pattern and a surface.
  //
  // 0.55 cells of rise per cell of run at a typical slope, which is a fairly
  // dramatic relief -- around 30 degrees. Tuned by eye at 6000x1200: higher
  // looks embossed and metallic, lower goes flat.
  vec3 nrm = normalize(vec3(-grad * (0.55 * GRAD_NORM), 1.0));

  // Key light from the upper left, the default for reading relief as raised
  // rather than sunken.
  vec3 lightDir = normalize(vec3(-0.5, 0.62, 0.6));
  float diff = clamp(dot(nrm, lightDir), 0.0, 1.0);

  // Half-vector specular against a head-on viewer. Narrow and strong: it is
  // what puts a highlight on the crest of each ridge and reads as wet or
  // molten rather than matte.
  vec3 halfV = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float spec = pow(clamp(dot(nrm, halfV), 0.0, 1.0), 34.0);

  // Cheap ambient occlusion: valleys of the heightfield are self-shadowed.
  float ao = clamp(0.45 + 0.75 * (h + 0.35), 0.25, 1.0);

  // ---- Colour -------------------------------------------------------------
  // Hue varies only at very low frequency (0.4 cells per screen height against
  // the surface's ~4) and over a narrow span. Both bounds are the point: a hue
  // that varies as fast as the detail averages to grey, and a hue that sweeps
  // the whole wheel gives a rainbow rather than a palette. +/-0.07 turns is
  // about 25 degrees each way, an analogous scheme.
  //
  // The drift term is 0.0018 turns/second: one lap of the hue wheel per nine
  // minutes, against a ten-minute rotation slot. Fast enough that a long look
  // is not a still image, slow enough that no single glance sees it move.
  float hueField = snoise(vec3(uv * 0.4, t * 0.017) + offset.zxy);
  float hue = baseHue(iSeed.y) + 0.07 * hueField + 0.0018 * t;

  // Lightness carries the structure. Range 0.05..~1.0 in OKLab L, so there are
  // genuine blacks and genuine highlights rather than the old flat 0.75.
  float lit = 0.05 + 0.74 * diff * ao;
  float crest = smoothstep(0.10, 0.68, h);
  float L = clamp(lit + 0.26 * crest, 0.0, 1.0);

  // Chroma falls off at both ends: near black there is no chroma to see, and
  // hot crests desaturating toward white is what makes them read as *bright*
  // rather than merely as a lighter version of the same colour.
  float chroma = 0.125 * smoothstep(0.0, 0.20, L) * (1.0 - 0.45 * smoothstep(0.72, 1.0, L));
  float a = TAU * hue;
  vec3 col = max(oklabToLinear(vec3(L, chroma * cos(a), chroma * sin(a))), 0.0);

  // ---- Composition --------------------------------------------------------
  // A very low-frequency energy field, drifting slower than everything else.
  // Without it a 5:1 canvas is uniformly busy from end to end and the eye has
  // nowhere to rest; with it, whole stretches of the wall fall to a deep quiet
  // base and the bright regions read as events. This is the single change that
  // most affects how the saver looks at wall aspect.
  float energy = snoise(vec3(uv * 0.20, t * 0.012) + offset.yzx * 0.7);
  // Biased dark: the midpoint sits at +0.2 rather than 0, so rather more than
  // half of the field falls into the quiet base. An unbiased mask leaves the
  // wall evenly busy, which is the failure this exists to fix.
  float mask = smoothstep(-0.25, 0.75, energy);
  // The floor is 0.20 rather than something near zero. A quiet region should be
  // *dim plasma*, not an absence of image: a black patch on a lit-room videowall
  // reads as a dead panel, it disappears entirely under the ambient washout, and
  // it leaves shadercheck's structure probe with nothing to measure if its
  // 512px sample happens to land there.
  col *= 0.20 + 1.25 * mask;

  // Specular and crest glow are added *after* the mask so the brightest ridges
  // in an active region genuinely exceed 1.0 and the bloom in the post chain
  // has something real to find. Feeding pre-tonemapped colour into the chain is
  // issue #140; these are HDR values.
  // Same reasoning as the mask floor: the quiet regions keep a fraction of the
  // highlights, so they still glint rather than going inert.
  float active = 0.18 + 0.82 * mask;
  float heat = active * pow(crest, 3.0);
  col += col * 2.2 * heat;
  col += vec3(1.0, 0.92, 0.82) * spec * (0.22 + 1.4 * heat) * active;

  // Deep ambient floor, tinted the complement of the base hue so the quiet
  // regions are a colour rather than an absence of one.
  float ca = TAU * (baseHue(iSeed.y) + 0.5);
  col += max(oklabToLinear(vec3(0.16, 0.05 * cos(ca), 0.05 * sin(ca))), 0.0) * 0.9;

  fragColor = vec4(col, 1.0);
}
`

export default createShaderScreensaver('Plasma', SHADER, {
  // Threshold below the crest peaks (measured ~2.5-4 in the HDR target) so the
  // bloom picks out lit ridges and highlights only, not the whole field. A
  // threshold at 1.0 would catch almost nothing here -- see the note in
  // post-fx.js on HDR vs LDR savers.
  postFX: {
    bloom: { threshold: 0.85, knee: 0.4, intensity: 0.5, radius: 1.0 },
    tonemap: 'aces',
    dither: true,
  },
})
