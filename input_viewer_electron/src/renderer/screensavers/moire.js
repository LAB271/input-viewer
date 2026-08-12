// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Moiré interference — two overlapping gauzes whose *beat* is the subject
 * (#98, #181).
 *
 * The previous version multiplied two rotating line grids and hoped the moiré
 * would appear. It did not: the beat between two grids at a large relative
 * angle has almost the same period as the grids themselves, so a 3000x600
 * capture showed the carrier and nothing else -- a flat denim weave. Moiré
 * fringes are a *low* frequency phenomenon, and the parameters have to be
 * chosen to put them there.
 *
 * The fix is to stop treating the fringes as an emergent property of sampling
 * and compute them directly. The product of two cosine gratings is
 *
 *     cos(A) * cos(B) = 0.5 * [ cos(A - B) + cos(A + B) ]
 *
 * The difference term *is* the moiré. Evaluating cos(A - B) analytically gives
 * an exact, band-limited fringe envelope at whatever scale the parameters
 * dictate, independent of resolution -- so the fringes are as crisp on a
 * laptop as on the wall, and no part of the look depends on aliasing.
 *
 * Every grating therefore carries its analytic phase *gradient* alongside its
 * phase. That buys three things fwidth() cannot: correct band-limiting across
 * the spiral's branch cut (where fwidth spikes and would cut a dark seam
 * radially across the frame), band-limiting of the fringe envelope itself and
 * not just the carrier, and free offset sampling for the inter-layer shadow
 * (shifting position by o changes phase by dot(grad, o)).
 *
 * Per-activation variation (iSeed): layer geometry pairing, carrier frequency,
 * duty cycle, spiral arm count, palette rotation and every animation phase.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.worldSpace}
${GLSL.palette}

const float TAU = 6.28318530718;
const float INV_TAU = 0.15915494309;

// ============================================================================
// Gratings
//
// Each returns vec3(phase, dPhase/dx, dPhase/dy). Phase is in *cycles* of
// world space rather than radians, because every consumer below wants cycles:
// fract() gives the position within a bar directly, and the gradient magnitude
// divided by pixels-per-unit is cycles-per-pixel, which is what has to be
// compared against Nyquist.
// ============================================================================

/** Parallel lines with normal at angle ang. Phase is linear, so the gradient
 *  is constant -- the reference case. */
vec3 gratingLines(vec2 p, float freq, float ang) {
  vec2 n = vec2(cos(ang), sin(ang));
  return vec3(dot(p, n) * freq, n * freq);
}

/** Concentric rings about c. grad(r) is the outward unit vector. */
vec3 gratingRings(vec2 p, vec2 c, float freq) {
  vec2 d = p - c;
  // Guarded: the gradient is undefined exactly at the centre, and an unguarded
  // divide there produces a single NaN pixel that bloom then smears outward.
  float r = max(length(d), 1e-4);
  return vec3(r * freq, (d / r) * freq);
}

/** Archimedean spiral: rings plus a whole number of turns per revolution.
 *
 *  arms must be an integer. The atan branch cut jumps by TAU, which changes
 *  the phase by exactly 'arms' cycles -- invisible to fract() only if that is
 *  a whole number, otherwise a hard seam runs from the centre to the edge.
 *
 *  grad(theta) = (-dy, dx) / r^2, so the angular term diverges at the centre.
 *  That is physically right (the arms really do converge to nothing) and the
 *  band-limiting below turns it into a soft core rather than a mess. */
vec3 gratingSpiral(vec2 p, vec2 c, float freq, float arms) {
  vec2 d = p - c;
  float r = max(length(d), 1e-3);
  float th = atan(d.y, d.x) * INV_TAU;
  vec2 perp = vec2(-d.y, d.x) / (r * r);
  return vec3(r * freq + arms * th, (d / r) * freq + arms * INV_TAU * perp);
}

// ============================================================================
// Band-limiting
// ============================================================================

/**
 * Visibility of periodic detail running at cpp cycles per pixel.
 *
 * Nyquist is 0.5 cycles/px. This fades out between 0.13 and 0.30, so detail is
 * gone by the time it is at 60% of Nyquist. The margin is deliberately large:
 * the wall is fed through a scaler and a compressor that both resample, and a
 * pattern that is merely *just* legal at the source crawls once anything
 * downstream touches it. The design keeps the carrier around 0.02 cycles/px
 * anyway -- this is insurance for the spiral core and for dense fringe
 * regions, not the main defence.
 */
float detailVisibility(float cpp) {
  return 1.0 - smoothstep(0.13, 0.30, cpp);
}

/**
 * One opaque bar per cycle, antialiased from the analytic gradient.
 *
 * tri is 0 at the centre of a bar and 1 at the centre of a gap, so 'duty' is
 * literally the opaque fraction of the gauze. tri changes by 2*cpp per pixel,
 * hence the 2.5x -- a smoothstep about one pixel and a quarter wide.
 */
float barMask(float phase, float cpp, float duty) {
  float tri = abs(fract(phase) - 0.5) * 2.0;
  float aa = max(cpp * 2.5, 1e-4);
  return 1.0 - smoothstep(duty - aa, duty + aa, tri);
}

// ============================================================================
// Colour
// ============================================================================

/** OKLCH -> linear sRGB. Requires GLSL.palette for oklabToLinear. */
vec3 oklch(float L, float C, float hueTurns) {
  float h = TAU * hueTurns;
  return max(oklabToLinear(vec3(L, C * cos(h), C * sin(h))), 0.0);
}

/**
 * Three-stop perceptual ramp driven by the fringe envelope.
 *
 * Interpolating in OKLCH rather than OKLab keeps chroma along an arc instead
 * of a chord, so the ramp does not desaturate through its midpoint. Lightness
 * climbs monotonically 0.24 -> 0.58 -> 0.94 across the ramp: the envelope is
 * bounded in [0,1] by construction, so unlike the old
 * palettePerceptual(0.15 + field * 0.35 + iTime * 0.03) this is a real
 * value ramp expressing the interference rather than an arbitrary hue index
 * on an unbounded field.
 *
 * The hue arc spans 0.43 turn (deep indigo -> magenta -> warm white), which is
 * the amount of hue travel that still reads as one material lit at different
 * strengths rather than as a rainbow.
 *
 * Chroma peaks in the middle. Deep shadow and specular crest are both close to
 * neutral in any real material, and holding chroma up at L=0.94 pushes several
 * hues out of sRGB, which clips back to exactly the flat patches this is meant
 * to avoid.
 */
vec3 fringeRamp(float e, float hueBase) {
  vec3 lo  = vec3(0.15, 0.055, hueBase + 0.70);
  vec3 mid = vec3(0.45, 0.175, hueBase + 0.90);
  vec3 hi  = vec3(0.85, 0.135, hueBase + 1.08);
  // Two smoothstep-eased segments. Both have zero slope at the join, so the
  // ramp is C1 continuous there and no crease shows along the mid-tone.
  vec3 lch = e < 0.5
    ? mix(lo,  mid, smoothstep(0.0, 1.0, e * 2.0))
    : mix(mid, hi,  smoothstep(0.0, 1.0, (e - 0.5) * 2.0));
  return oklch(lch.x, lch.y, lch.z);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // World space -- divide by the short axis so rings stay circular and bar
  // pitch is the same physical size at any aspect (issue #114).
  vec2 uv = worldFromFrag(fragCoord, iResolution.xy);
  float aspect = iResolution.x / max(iResolution.y, 1.0);
  // One world unit is exactly the display height, which makes this the
  // world-to-pixel scale used for every Nyquist test below.
  float pxPerUnit = max(iResolution.y, 1.0);

  // -- per-activation choices ------------------------------------------------
  // Four layer pairings, each with a recognisably different fringe geometry.
  // iSeed is a uniform, so this branch is coherent across the whole draw.
  int mode = int(min(iSeed.x * 4.0, 3.0));
  float hueBase = iSeed.w;

  /* Carrier frequency in cycles per world unit, i.e. bars per display height.
     17-26 puts the bar pitch at 46-70px on the 6000x1200 wall, about 0.02
     cycles/px -- a factor of 25 below Nyquist. The old version ran 26-42 and
     then multiplied two of them, which put the visible sum-frequency term
     inside a few pixels. Coarse bars are not a compromise here: the fringes
     are the subject and the carrier is texture on them. */
  float freq = 17.0 + iSeed.y * 9.0;

  /* The two animated mismatches, and the reason this saver finally shows
     fringes. For two line gratings the fringe wavevector is kA - kB; with
     equal frequencies its magnitude is 2*freq*sin(dAng/2), so dAng = 0.20 rad
     at freq 20 gives 4 cycles per world unit -- fringes 300px apart on the
     wall, against a 60px carrier. That factor of five separation is the
     "fringe regime".

     Both oscillate about zero at incommensurate rates, so each sweeps *through*
     zero: the fringes dilate towards infinity, the frame goes briefly uniform,
     and they collapse back in. Because the two terms cross zero at different
     times they hand over to each other -- dAng alone gives fringes across the
     bars, dFreq alone gives fringes along them, so a dAng crossing rotates the
     whole fringe family by 90 degrees. That handover is the effect worth
     watching, and it is why they are not driven by one shared clock.

     0.061 and 0.043 rad/s put a crossing roughly every 50 and 73 seconds; over
     a 10-minute rotation slot that is a dozen of them. */
  float dAng  = 0.155 * sin(iTime * 0.061 + iSeed.z * TAU);
  float dFreq = 2.40 * sin(iTime * 0.043 + iSeed.y * TAU);

  /* Slow absolute rotation on top, one turn per ~9.5 minutes, so orientation
     genuinely evolves over a viewing slot instead of the pattern being
     statistically identical at second 5 and second 500. */
  float baseAng = iSeed.x * TAU + iTime * 0.011;

  /* Fringe centre wanders over most of the 5:1 frame rather than sitting in
     the middle. The x amplitude scales with aspect, so it traverses the wall
     and not just the central square. */
  vec2 span = vec2(0.42 * aspect, 0.26);
  vec2 cA = span * vec2(sin(iTime * 0.023 + iSeed.z * TAU),
                        sin(iTime * 0.031 + iSeed.w * TAU));

  /* Separation of the second centre, also oscillating through zero: at sep = 0
     the two ring sets are perfectly concentric and the hyperbolic fringes
     unwind into nothing. */
  float sep = 0.115 * sin(iTime * 0.037 + iSeed.x * TAU);
  float sepAng = iTime * 0.013 + iSeed.y * TAU;
  vec2 cB = cA + sep * vec2(cos(sepAng), sin(sepAng));

  /* Neither gauze hangs perfectly flat. A shallow sine warp, opposite on the
     two layers, bends the fringes into organic curves and stops the line-pair
     mode reading as a test chart. Amplitude x frequency is 0.021 * 4.3 = 0.09,
     so the analytic gradients below -- which ignore the warp -- are within 9%.
     The band-limit thresholds have far more margin than that. */
  vec2 warp = 0.021 * vec2(sin(uv.y * 4.3 + iTime * 0.070),
                           sin(uv.x * 3.1 - iTime * 0.051));
  vec2 pA = uv + warp;
  vec2 pB = uv - warp * 0.7;

  // -- the two layers --------------------------------------------------------
  vec3 A, B;
  if (mode == 0) {
    // Line x line: straight parallel fringes running across the bars.
    A = gratingLines(pA, freq + dFreq * 0.5, baseAng + dAng * 0.5);
    B = gratingLines(pB, freq - dFreq * 0.5, baseAng - dAng * 0.5);
  } else if (mode == 1) {
    // Ring x ring: the two-source hyperbolae, densest along the line joining
    // the centres and opening out to either side -- large-scale composition
    // for free, since fringe scale varies across the frame.
    A = gratingRings(pA, cA, freq + dFreq * 0.5);
    B = gratingRings(pB, cB, freq - dFreq * 0.5);
  } else if (mode == 2) {
    // Spiral x ring: the radial terms cancel, leaving a fan of 'arms' sectors
    // that winds into a spiral as dFreq moves off zero and unwinds as it
    // returns. Whole number of arms, or the branch cut shows (see above).
    float arms = floor(3.0 + iSeed.z * 5.0);
    A = gratingSpiral(pA, cA, freq + dFreq * 0.5, arms);
    B = gratingRings(pB, cB, freq - dFreq * 0.5);
  } else {
    // Line x ring: conic fringes. freqA/freqB is the eccentricity, so dFreq
    // sweeping through zero carries the family ellipse -> parabola ->
    // hyperbola and back.
    A = gratingLines(pA, freq + dFreq * 0.5, baseAng);
    B = gratingRings(pB, cA, freq - dFreq * 0.5);
  }

  // -- the moiré -------------------------------------------------------------
  // The difference term, evaluated directly. Its gradient is the difference of
  // the layer gradients, which is what makes the fringes band-limitable in
  // their own right.
  float beatPhase = A.x - B.x;
  vec2  beatGrad  = A.yz - B.yz;
  float beatCpp   = length(beatGrad) / pxPerUnit;

  float env = 0.5 + 0.5 * cos(TAU * beatPhase);
  // Where the fringes themselves run fine -- near the axis in the ring pair,
  // near the core in the spiral -- fade them to their own mean rather than
  // letting them alias. This is the insurance the issue asks for.
  env = mix(0.5, env, detailVisibility(beatCpp));
  /* Contrast shaping. A raw cosine spends half its range above 0.5, which at
     5:1 fills the frame edge to edge with equally weighted light and dark
     bands and reads as a zebra. The 1.9 exponent narrows the bright fringe to
     roughly a third of each period and lets the rest fall away, which is what
     leaves negative space for the eye. The smoothstep first is a gentle
     shoulder, not a threshold -- clipping the crest flat would kill the
     specular read. */
  env = smoothstep(0.02, 0.98, env);
  env = pow(env, 1.7);

  // -- carrier, as luminance structure only ----------------------------------
  float cppA = length(A.yz) / pxPerUnit;
  float cppB = length(B.yz) / pxPerUnit;
  // Opaque fraction of each gauze. Near 0.5 the two layers can just occlude
  // each other completely, which is what gives the fringes their full depth;
  // much above that and the troughs never close.
  float duty = 0.46 + 0.08 * iSeed.z;
  float tA = barMask(A.x, cppA, duty);
  float tB = barMask(B.x, cppB, duty);

  /* Shadow of the front gauze cast onto the back one. Offsetting the sample
     position by o changes the phase by dot(grad, o) to first order, so this
     costs one extra barMask and no extra geometry. The offset is the gap
     between the layers projected along the light direction; it is small, so
     the shadow reads as a soft dark edge beside each bar rather than as a
     second grating. */
  vec2 lightOffset = vec2(0.007, -0.011);
  float shadow = barMask(A.x + dot(A.yz, lightOffset), cppA, duty);
  float carrier = tA * tB * (0.58 + 0.42 * shadow);

  /* As the carrier approaches the resolution limit it has to converge on its
     own local mean, not to noise. That mean is the envelope: two duty-0.5
     gratings overlap between 0 and 0.5 of the area as the beat phase runs, so
     env * 0.5 is exactly where a correctly resolved carrier averages out. */
  carrier = mix(env * 0.5, carrier, detailVisibility(max(cppA, cppB)));

  // Remap to a brightness modulation about 1. The carrier only ever scales
  // luminance -- hue and chroma come from the envelope alone, which is what
  // makes the fringes and not the weave the thing that reads at distance.
  float structure = 0.34 + 1.32 * carrier;

  /* A broad, slowly drifting light behind the gauzes. Without it the 5:1 frame
     is uniformly busy from end to end; with it there is a lit region and two
     resting ones, and they move. The 0.30 floor is ambient, so the dark end
     still shows the weave rather than going to a flat tint (issue #88). */
  vec2 lightPos = vec2(sin(iTime * 0.019 + iSeed.y * TAU) * 0.46 * aspect,
                       sin(iTime * 0.026 + iSeed.z * TAU) * 0.24);
  vec2 lightDelta = uv - lightPos;
  float lit = 0.13 + 1.00 * exp(-dot(lightDelta, lightDelta) * 0.50);

  vec3 col = fringeRamp(env, hueBase) * structure * lit;

  /* Genuine highlights for the bloom, kept in HDR and handed to the post chain
     untonemapped (issue #140). Only the top fifth of the envelope glows, and
     only where the light is, so the glow follows the fringe crests instead of
     fogging the whole frame. Squaring 'crest' tightens it further. */
  float crest = smoothstep(0.86, 1.0, env);
  col += oklch(0.92, 0.100, hueBase + 1.10) * crest * crest * 1.15 * lit;

  fragColor = vec4(col, 1.0);
}
`

// Bloom on the fringe crests only. The measured peak in the HDR target is
// around 3.0, so the threshold sits below it per the HDR-vs-LDR note in
// post-fx.js -- high enough that the lit mid-tones do not bleed, low enough
// that the crests genuinely glow.
export default createShaderScreensaver('Moire Interference', SHADER, {
  postFX: {
    bloom: { threshold: 1.00, knee: 0.35, intensity: 0.28, radius: 0.75 },
    tonemap: 'aces',
  }
})
