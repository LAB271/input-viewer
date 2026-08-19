// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Mandelbrot -- an actual infinite dive, by perturbation theory (issue #121).
 *
 * The previous version zoomed to exp(1) ~ 2.7x and back out again. That was not
 * a design choice, it was a precision workaround: iterating z = z^2 + c directly
 * in 32-bit floats runs out of mantissa somewhere around 1e5, so a deeper zoom
 * would have dissolved into blocky mush. The defining pleasure of a Mandelbrot
 * screensaver -- falling endlessly into detail -- was exactly what it did not do.
 *
 * HOW THE DEPTH IS BOUGHT
 *
 * Perturbation theory, the technique every modern deep-zoom renderer uses. One
 * REFERENCE ORBIT Z_n is iterated on the CPU at the dive's centre C in
 * double-double arithmetic (~106 bits, see the ddAdd/ddMul block below) and
 * uploaded as a float texture. The shader then never iterates z at all; it
 * iterates the DELTA d = z - Z from that orbit:
 *
 *     z = Z + d,  c = C + dc
 *     (Z + d)^2 + (C + dc) = (Z^2 + C) + 2*Z*d + d^2 + dc
 *     => d' = (2*Z + d) * d + dc
 *
 * That identity is exact algebra, not an approximation. The win is that d and
 * dc are pixel-sized -- 1e-25 rather than 1e0 -- so their 24-bit mantissas buy
 * precision *relative to the pixel*, which is the only precision that matters.
 * The absolute coordinate lives entirely on the CPU side, in double-double.
 *
 * Two further details make it work in 32-bit floats specifically:
 *
 *  - The delta is stored SCALED, as e = d / S where S is the view half-height.
 *    Unscaled, d^2 at a 1e-25 zoom is 1e-50 and flushes to zero (float32 goes
 *    denormal below 1.2e-38), so the quadratic term -- the one that matters
 *    exactly when the reference is a poor predictor -- silently vanishes.
 *    Written as (2*Z + S*e) * e, no intermediate ever leaves float range.
 *
 *  - REBASING (Zhuoran, 2021) replaces classical glitch detection. Whenever the
 *    true |z| falls below |d|, the reference has stopped being a useful
 *    predictor -- this is Pauldelbrot's glitch condition -- and the fix is to
 *    restart the reference index at 0 with d := z, which is exact because
 *    Z_0 = 0. One reference orbit therefore renders the whole frame with no
 *    glitch blobs and no second-reference pass. The same branch also fires when
 *    the orbit index reaches the end of the uploaded table, which is what keeps
 *    a reference that escapes from ever being indexed out of range.
 *
 * WHERE IT STOPS
 *
 * At the double-double reference, not at the shader. dd carries ~32 significant
 * digits; a dive to 1e-24 spends 24 of them on the coordinate and leaves 8 as
 * guard digits against the orbit's own error amplification, which is about the
 * accepted margin. MAX_DIVE_LOG2 is set from that. Going deeper is a CPU-side
 * change only -- triple-double or a small bignum -- with no shader work at all,
 * which is the point of doing it this way.
 *
 * DIVE TARGETS
 *
 * A randomly chosen coordinate is overwhelmingly likely to be flat black or
 * flat exterior, and that gets worse with depth, so the targets are curated.
 * They were found offline by a boundary descent: sample a grid across the view,
 * re-centre on the escaping point with the highest iteration count, halve the
 * radius, repeat 90 times -- which converges on Misiurewicz points and minibrot
 * neighbourhoods, i.e. exactly the places that keep resolving. Each was then
 * graded at six depths along its path for interior fraction and edge density,
 * so none of them dives into a featureless region on the way down.
 *
 * RENDERING
 *
 *  - Distance estimation. dz/dc is carried alongside z, giving |z|*ln|z|/|dz/dc|
 *    -- the distance to the set in screen pixels. Used for analytic edge
 *    antialiasing (the exterior/interior blend is a smoothstep over one pixel of
 *    distance, not a hard test), for the bright rim the bloom picks up, and for
 *    the falloff that lets the far exterior go dark instead of flooding the wall
 *    with saturated colour.
 *  - Stripe average colouring (Harkonen). The mean of a periodic function of
 *    arg(z) over the orbit, smoothly interpolated at the escape iteration. This
 *    is what produces intricate lace instead of concentric bands. The angular
 *    function is Im(w^2) mixed with Im(w^4) on the unit vector w = z/|z|, which
 *    is sin(2*theta)/sin(4*theta) computed by two complex squarings -- markedly
 *    cheaper than atan+sin in the innermost loop.
 *  - Interior colouring by atom domain: hue from the iteration of closest
 *    approach to the origin (a period estimate), lightness from how close it
 *    got. The body of the set is structured and dark rather than flat black.
 *  - Temporal supersampling. One jittered sample per pixel per frame, blended
 *    into a reprojected history buffer. Reprojection is exact and free here:
 *    the camera is a pure zoom about a fixed centre, so the previous frame's
 *    coordinate is the current one times a scale ratio, and it is always on
 *    screen because zooming in only ever magnifies. Over a slow dive this
 *    converges to a very clean image, which is the correct fix for filigree
 *    shimmer -- brute-force supersampling would multiply an already expensive
 *    shader.
 *  - HDR out to the shared post chain (#112/#113): bloom on the rim, ACES,
 *    dither, and OKLab ramps for the palette (#115).
 */
import { createGLRuntime, createFullscreenPass, createHdrColorTarget, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// =============================================================================
// Double-double arithmetic.
//
// A value is a [hi, lo] pair with |lo| <= ulp(hi)/2, evaluating to hi + lo
// exactly, so the pair carries ~106 bits -- about 32 significant digits against
// a double's 16. These are the classic Dekker/Knuth error-free transformations;
// the folder has zero dependencies and this is the whole of what is needed
// (add, subtract, multiply on values bounded by 4), so pulling in decimal.js
// for it would be the larger change.
//
// Only the reference orbit uses these, once per dive: a few thousand complex
// steps, well under a millisecond. Nothing here is on the per-frame path.
// =============================================================================

// 2^27 + 1. Dekker's splitter: multiplying by it and subtracting isolates the
// top 26 bits of a double, so a product can be computed without rounding error.
const DD_SPLITTER = 134217729

function twoSum(a, b) {
  const s = a + b
  const bb = s - a
  return [s, (a - (s - bb)) + (b - bb)]
}

function quickTwoSum(a, b) {
  const s = a + b
  return [s, b - (s - a)]
}

function twoProd(a, b) {
  const p = a * b
  const at = DD_SPLITTER * a
  const ah = at - (at - a)
  const al = a - ah
  const bt = DD_SPLITTER * b
  const bh = bt - (bt - b)
  const bl = b - bh
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl]
}

function ddAdd(a, b) {
  const s = twoSum(a[0], b[0])
  return quickTwoSum(s[0], s[1] + a[1] + b[1])
}

function ddSub(a, b) { return ddAdd(a, [-b[0], -b[1]]) }

function ddMul(a, b) {
  const p = twoProd(a[0], b[0])
  return quickTwoSum(p[0], p[1] + (a[0] * b[1] + a[1] * b[0]))
}

// =============================================================================
// Curated dive targets.
//
// Found by the offline boundary descent described in the header. Stored as the
// raw [hi, lo] double pairs rather than decimal strings so the value is exactly
// what the search produced -- a decimal round trip through parseFloat would
// silently drop the low word, which is the entire point of the pair. The
// comment carries the human-readable 30-digit form.
//
// `refEscape` is the iteration at which the centre's own orbit escapes. It must
// stay comfortably above REF_ORBIT_LEN or the shader's end-of-table rebase
// would fire on every pixel at depth, degrading the delta iteration to plain
// float32 exactly where the precision is needed.
// =============================================================================
const DIVE_TARGETS = [
  // -0.650184794685523490381707330622 + 0.353055535780441321015469960749i  refEscape 6012
  { x: [-0.6501847946855235, -8.720713691825156e-18], y: [0.3530555357804413, 2.2427652660391426e-17] },
  // -0.698213700924294027830922867118 + 0.258982688816175789618703959068i  refEscape 4698
  { x: [-0.698213700924294, -4.95499620968411e-18], y: [0.2589826888161758, -2.043501734768949e-17] },
  // -1.047061989001584824736346973071 - 0.247016285343538250785045008299i  refEscape 4707
  { x: [-1.0470619890015849, 4.4904390478774276e-17], y: [-0.24701628534353826, 4.718358880424898e-18] },
  // -1.336337945564129118114066522500 - 0.052729299598221869195584244676i  refEscape 4698
  { x: [-1.336337945564129, -1.429924545791155e-17], y: [-0.05272929959822187, -1.0117282132115765e-18] },
  // -0.294091172818190307590953419957 + 0.645193540195812290351650888080i  refEscape 4705
  { x: [-0.2940911728181903, -2.497131685185575e-18], y: [0.6451935401958123, -3.0273983695767336e-17] },
  // -1.070836780518782844648274225119 - 0.240531610570935122581453344648i  refEscape 4689
  { x: [-1.0708367805187828, -6.547441192606001e-18], y: [-0.2405316105709351, -1.10332014056646e-17] },
  // -0.645509523133209991149597167520 - 0.363403402937936236819343715454i  refEscape 4706
  { x: [-0.64550952313321, -1.8593295985908636e-17], y: [-0.3634034029379362, -2.164141613631991e-17] },
  // -0.733502628478212806815884827326 + 0.153003983591107477911714413581i  refEscape 4710
  { x: [-0.7335026284782128, -1.4264879477220864e-17], y: [0.15300398359110748, -6.784176047439331e-19] },
  // -0.742879200994253716317357472715 + 0.103722931699126842974884850487i  refEscape 4707
  { x: [-0.7428792009942538, 3.588201248291789e-17], y: [0.10372293169912684, -1.0990811190403417e-18] },
  // -0.633540138874200415797610902575 - 0.443703272637439633418329387656i  refEscape 4698
  { x: [-0.6335401388742005, 4.889384427873393e-17], y: [-0.44370327263743964, 5.107717404665631e-18] },
]

/**
 * Iterations of reference orbit uploaded per dive.
 *
 * 4608 = 512 x 9 texels. It has to sit above the deepest iteration cap
 * (ITER_BASE + ITER_PER_DOUBLING * MAX_DIVE_LOG2 = 4460) and below the smallest
 * refEscape in the table above (4689), so the shader neither runs off the end
 * of the orbit nor indexes past where the reference stopped being valid.
 */
const REF_ORBIT_LEN = 4608
/** Texture width for the orbit table; height follows from REF_ORBIT_LEN. */
const REF_TEX_WIDTH = 512

/**
 * Deepest zoom, as a power of two below the starting view.
 *
 * 80 doublings is a linear scale factor of 1.2e24. The binding constraint is
 * the double-double reference orbit, not the shader: dd carries ~32 significant
 * digits, the coordinate consumes ~24 at this depth, and the remaining ~8 guard
 * digits absorb the error amplification along the orbit (which near a boundary
 * point grows roughly like |dz/dc|, i.e. like 1/S). Pushing to 90+ starts to
 * eat the guard digits and the deepest frames lose their crispness.
 */
const MAX_DIVE_LOG2 = 80

// Iteration budget. Escape times grow with depth -- the fixed 256 this saver
// used to use is invisible at a 2.7x zoom and catastrophic at 1e25, where every
// pixel that has not escaped by the cap reads as interior and the frame fills
// with a flat false-interior wash. The slope matches the schedule the offline
// descent ran at (50 per doubling), which is also what fixes the targets'
// iteration appetite: the descent selects the highest-escape-time point it can
// see, so its own cap is what the neighbourhood ends up demanding. Measured the
// hard way -- a first pass ran the descent at 75 per doubling and the runtime at
// 55, and the last third of every dive was solid false interior.
const ITER_BASE = 300
const ITER_PER_DOUBLING = 52

// Adaptive cap (issue #116). The budget above is what the image *wants*; this
// is what the GPU can afford. Frame cost here is genuinely unbounded -- 6000x1200
// at 3000 iterations is billions of complex multiplies -- so the iteration count
// is closed-loop on measured frame time rather than guessed. The floor keeps the
// image recognisable on a slow software rasteriser; the ceiling is the uploaded
// orbit length.
const TARGET_FRAME_MS = 20
// The floor grows with depth as well. Starving the loop is not a graceful
// degradation: every pixel that has not escaped by the cap is drawn with the
// interior colouring, so an under-budgeted deep frame does not merely lose fine
// detail, it fills with false interior. Below this the picture is wrong rather
// than cheap, so the frame rate is allowed to give way instead.
const MIN_ITER_BASE = 220
const MIN_ITER_PER_DOUBLING = 40

// WHAT THIS COSTS ON THE WALL, AND WHY IT IS THE FLOOR'S PRICE (#225)
//
// #225 measured every saver at 6000x1200 and put this one below 30 fps. That is
// the floor above doing what it is for, not a defect, and the numbers are worth
// stating so nobody "optimises" it by starving the loop.
//
// The budget is deterministic from the constants above:
//
//   log2Depth      floor    wanted
//           0        220       300
//          20       1020      1340
//          40       1820      2380
//          60       2620      3420
//          80       3420      4460
//
// Measured at 6000x1200 on a real GPU (ANGLE/Metal, M3 Pro, seed 4242):
//
//   15s run, shallow    26.6 fps    37.6 ms/frame
//   60s run, deeper     13.0 fps    76.9 ms/frame
//
// So there is no single frame rate for this saver: cost climbs with dive depth
// because the budget does, and it roughly halves over the first minute. Any figure
// quoted for it has to say how far into the dive it was taken -- #225's 26.6 was at
// 15s, early.
//
// The closed loop is not achieving TARGET_FRAME_MS at this resolution and cannot.
// It reduces maxIter whenever the EMA exceeds TARGET_FRAME_MS * 1.15 = 23 ms, and
// at 37-77 ms that is every frame, so maxIter is driven down until it clamps here
// at the floor and stays. TARGET_FRAME_MS is therefore aspirational on the wall
// rather than met: it governs behaviour on smaller canvases, where there is slack.
//
// Which makes the trade-off explicit. Going faster at 6000x1200 means lowering
// MIN_ITER_BASE or MIN_ITER_PER_DOUBLING, and the comment above says what that
// buys: not less fine detail but false interior, because every pixel that has not
// escaped by the cap is drawn with the interior colouring. A cheaper deep frame is
// a wrong one. That is a quality decision, not a performance fix, and it belongs
// to whoever owns how the dive should look.

// Dive pacing. A doubling every ~3.5s is contemplative rather than dizzying,
// and takes the full 80 doublings in about 4.5 minutes -- so a 10-minute
// no-signal rotation slot shows two complete, different dives.
const DIVE_RATE_MIN = 0.24
const DIVE_RATE_MAX = 0.34
/** Seconds held at the bottom before the crossfade to the next target. */
const BOTTOM_HOLD_S = 7
/** Seconds of fade at each end of a dive. */
const FADE_S = 2.5
/**
 * Time constant of the ease-in, in seconds. The dive starts at zero rate and
 * relaxes onto the constant exponential rate, so the wide shot is held for a
 * beat instead of snapping away.
 */
const EASE_S = 5

/**
 * History weight for the temporal accumulation.
 *
 * 0.88 means each frame contributes 12%, a ~8-frame time constant. The upper
 * bound on usable history is set by magnification: at the dive rate above the
 * image grows ~0.25% per frame, so 8 frames of history are stale by ~2% of a
 * pixel -- far below the sample jitter it is averaging out. Higher weights look
 * cleaner still but start to smear the newly-resolved detail.
 */
const HISTORY_WEIGHT = 0.88

// =============================================================================
// Shaders
// =============================================================================

// Standard uniform block. This saver drives its own program rather than going
// through createShaderScreensaver (it needs the orbit texture, the history
// buffer and the dive uniforms), so it declares the Shadertoy-compatible set
// itself. Deliberately NOT inside a /* glsl */ template: the static check in
// test/screensaver-seed.test.js forbids a saver from re-declaring iSeed inside
// one, since for every other saver gl-base.js supplies it.
const FRAGMENT_HEADER = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
uniform vec4 iSeed;
out vec4 outColor;
`

const FRACTAL_SHADER = /* glsl */ `${GLSL.palette}

uniform sampler2D uRef;       // reference orbit, one texel per iteration
uniform sampler2D uHistory;   // previous resolved frame, for temporal AA
uniform int uRefWidth;        // orbit texture width, for the index unpack
uniform int uRefLen;          // valid orbit entries
uniform int uMaxIter;
uniform float uScale;         // view half-height in the complex plane
uniform float uPrevScale;     // ... on the previous frame, for reprojection
uniform float uHistoryBlend;  // 0 on the first frame of a dive
uniform vec2 uJitter;         // sub-pixel sample offset, in pixels
uniform float uHueRot;        // palette rotation, advanced once per dive
uniform float uLumBoost;      // big-room ambient-light compensation

// Bailout radius. 64 rather than the usual 2: both the smooth iteration count
// and the stripe average converge as the escape radius grows, and the cost is
// about four extra iterations because |z| squares each step. Not larger,
// because the scaled delta e reaches |z|/uScale at escape and (uScale*e)*e must
// stay inside float32 -- a bailout of 1e5 would overflow at these depths.
const float ESCAPE_R = 64.0;
const float ESCAPE_R2 = 4096.0;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

vec2 refAt(int i) {
  return texelFetch(uRef, ivec2(i % uRefWidth, i / uRefWidth), 0).xy;
}

/**
 * One pixel of the set. q is the position in world space (y in [-0.5, 0.5]),
 * which the dive scale turns into a delta from the reference coordinate.
 */
vec3 shadeFractal(vec2 q) {
  float S = uScale;
  vec2 dc = q;            // delta-c, already in units of S
  vec2 e = vec2(0.0);     // delta-z, in units of S
  vec2 dz = vec2(0.0);    // dz/dc, for the distance estimate
  vec2 z = vec2(0.0);     // the true orbit value, Z[m] + S*e
  int m = 0;              // index into the reference orbit
  int n = 0;              // true iteration count (rebasing does not reset it)
  float zz = 0.0;
  float sumPrev = 0.0, sum = 0.0;  // stripe sums to n-1 and n
  float minR2 = 1e20;              // closest approach to the origin
  int minIdx = 0;
  bool escaped = false;

  // Angular function for the stripe average: a blend of sin(2t) and sin(4t),
  // varied per activation so two runs do not draw the same lace.
  float stripeMix = 0.15 + 0.7 * iSeed.y;

  // Z[m] is carried across the loop rather than fetched twice per step (once as
  // the predictor, once to rebuild z). Z[0] is exactly the origin, so the rebase
  // branch can reset it without a fetch -- one texel read per iteration instead
  // of two, on a loop that runs into the thousands.
  vec2 Zm = vec2(0.0);

  for (int i = 0; i < uMaxIter; i++) {
    // Derivative first: it needs z from BEFORE this step.
    dz = 2.0 * cmul(z, dz) + vec2(1.0, 0.0);
    // d' = (2Z + d) * d + dc, in units of S so d^2 cannot underflow.
    e = cmul(2.0 * Zm + S * e, e) + dc;
    m++;
    Zm = refAt(m);
    z = Zm + S * e;
    zz = dot(z, z);
    n = i + 1;
    // Negated test so an inf or NaN from an extreme derivative also exits.
    if (!(zz < ESCAPE_R2)) { escaped = true; break; }

    vec2 w = z * inversesqrt(max(zz, 1e-30));
    vec2 w2 = vec2(w.x * w.x - w.y * w.y, 2.0 * w.x * w.y);
    vec2 w4 = vec2(w2.x * w2.x - w2.y * w2.y, 2.0 * w2.x * w2.y);
    sumPrev = sum;
    sum += 0.5 + 0.5 * mix(w2.y, w4.y, stripeMix);

    if (zz < minR2) { minR2 = zz; minIdx = n; }

    // Rebase. Chebyshev norms rather than |.|^2: squaring a 1e-30 delta
    // underflows float32, and the comparison would then never fire at exactly
    // the depths it exists for. The two norms agree to within sqrt(2), which is
    // immaterial for a test that only asks which value is smaller.
    if (max(abs(z.x), abs(z.y)) < S * max(abs(e.x), abs(e.y)) || m >= uRefLen - 1) {
      e = z / S;
      m = 0;
      Zm = vec2(0.0);
    }
  }

  // Smooth (continuous) iteration count, and the fraction of the last step the
  // orbit actually used before escaping.
  float lz = 0.5 * log(max(zz, 1.0001));
  float sn = float(n);
  float f = 1.0;
  if (escaped) {
    sn = float(n) - log2(lz / log(ESCAPE_R));
    f = clamp(sn - float(n) + 1.0, 0.0, 1.0);
  }

  // Stripe average, interpolated across the escape so it does not band.
  // Contrast expansion around 0.5: a running mean of a [0,1] quantity narrows
  // towards its expectation as the orbit lengthens -- past a few hundred
  // iterations the raw average spans little more than 0.45-0.55 -- so used
  // directly it renders as a flat mid-grey wash rather than lace. The 4.5 gain
  // reopens that window; higher starts clipping the deepest views to black and
  // white, which throws away the shading the stripes exist to provide.
  float a1 = sumPrev / max(float(n - 2), 1.0);
  float a2 = sum / max(float(n - 1), 1.0);
  float stripe = clamp((mix(a1, a2, f) - 0.5) * 4.5 + 0.5, 0.0, 1.0);

  // Interior: atom-domain colouring. The iteration of closest approach to the
  // origin estimates the local period, so it partitions the interior into cells
  // -- the structure that makes deep-zoom renders of the body of the set worth
  // looking at instead of a black hole. Hue is confined to a fifth of a turn so
  // the cells read as one material rather than as flat colour patches competing
  // with the filigree, and the shading inside a cell comes from both the closest
  // approach and the same stripe average that lights the exterior, which is what
  // keeps a large interior region from going flat.
  float mr = sqrt(max(minR2, 1e-30));
  float lift = clamp(-log(mr) * 0.11, 0.0, 1.0);
  float cell = uHueRot + iSeed.x + 0.55 + 0.2 * fract(float(minIdx) * 0.0371);
  vec3 inner = oklabRamp(cell, 0.15 + 0.17 * lift + 0.15 * stripe, 0.065, 0.0);
  if (!escaped) return inner * uLumBoost;

  // Exterior distance estimate, |z|*ln|z|/|dz/dc|, converted to pixels. The
  // derivative reaches ~1/uScale near the boundary, so |dz| is taken via a
  // Chebyshev-normalised length: dot(dz, dz) alone overflows float32 at depth.
  float gm = max(abs(dz.x), abs(dz.y));
  float dzLen = gm > 0.0 ? gm * length(dz / gm) : 0.0;
  float distPx = dzLen > 0.0 ? (sqrt(zz) * lz / (dzLen * S)) * iResolution.y : 1e6;

  // Hue tracks the smooth iteration count slowly: 0.0035 turns per iteration is
  // roughly two hue rotations across the ~500-iteration spread a deep view
  // typically holds, which reads as broad colour regions rather than the rainbow
  // moire a faster cycle gives at 6000px wide.
  vec3 base = oklabRamp(uHueRot + iSeed.x + sn * 0.0035, 0.66, 0.115, 0.0);

  float lit = 0.12 + 0.88 * pow(stripe, 1.3);
  // Rim and falloff. rim is the HDR term -- it runs past 1.0, so it is what the
  // bloom threshold picks up and nothing else blooms. far pulls the deep
  // exterior down towards black, which is what gives the frame negative space
  // instead of an even wall of saturated colour at 5:1.
  float rim = exp(-distPx * 0.55);
  float far = 1.0 / (1.0 + distPx * 0.012);
  vec3 col = base * lit * (0.22 + 0.78 * far) + base * rim * 2.4;

  // Analytic edge antialiasing: the exterior/interior transition is a smoothstep
  // over about one pixel of estimated distance rather than a hard predicate, so
  // the boundary is resolved below the sample grid.
  return mix(inner, col, smoothstep(0.0, 1.35, distPx)) * uLumBoost;
}

void main() {
  vec2 res = iResolution.xy;
  vec2 q0 = (gl_FragCoord.xy - 0.5 * res) / res.y;
  vec3 col = shadeFractal(q0 + uJitter / res.y);

  // Temporal accumulation. The camera is a pure zoom about a fixed centre, so
  // the same complex point sat at q0 * (uScale / uPrevScale) last frame -- one
  // multiply, no motion vectors. That ratio is always < 1 while zooming in, so
  // the reprojected sample is always on screen and there is no disocclusion
  // band to handle; the bounds test only guards the first frame after a resize.
  vec2 uvPrev = (q0 * (uScale / uPrevScale) * res.y + 0.5 * res) / res;
  vec3 hist = texture(uHistory, uvPrev).rgb;
  float inside = step(0.0, uvPrev.x) * step(uvPrev.x, 1.0)
               * step(0.0, uvPrev.y) * step(uvPrev.y, 1.0);
  outColor = vec4(mix(col, hist, uHistoryBlend * inside), 1.0);
}
`

// Resolve pass: copies the accumulation buffer into the post chain's HDR scene
// target, applying the dive crossfade. Kept separate from the fractal pass so
// the fade never contaminates the history the next frame reads back.
const RESOLVE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uFade;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uSrc, gl_FragCoord.xy * uTexel).rgb * uFade, 1.0);
}
`

// =============================================================================
// Reference orbit
// =============================================================================

/**
 * Iterate z = z^2 + c at a double-double centre and pack the orbit into an
 * RGBA32F-shaped array for upload.
 *
 * The orbit is stored in plain float32. That is not a compromise: the shader
 * only ever uses Z as a predictor, and an error there perturbs the delta by the
 * same *relative* 1e-7 each step, which random-walks rather than compounding.
 * What must be exact is the coordinate C the orbit starts from, and that is
 * where the double-double lives.
 *
 * @param {number[]} cx centre real part as a [hi, lo] double-double
 * @param {number[]} cy centre imaginary part
 * @param {number} count entries to produce
 * @returns {{data: Float32Array, len: number}} packed RGBA rows, and the number
 *   of entries before the orbit escaped (== count when it never does)
 */
function referenceOrbit(cx, cy, count) {
  const data = new Float32Array(count * 4)
  let zx = [0, 0]
  let zy = [0, 0]
  let len = count
  for (let i = 0; i < count; i++) {
    const x = zx[0] + zx[1]
    const y = zy[0] + zy[1]
    data[i * 4] = x
    data[i * 4 + 1] = y
    if (x * x + y * y > 4) { len = i + 1; break }
    const x2 = ddMul(zx, zx)
    const y2 = ddMul(zy, zy)
    const xy = ddMul(zx, zy)
    const nx = ddAdd(ddSub(x2, y2), cx)
    const ny = ddAdd(ddAdd(xy, xy), cy)
    zx = nx
    zy = ny
  }
  return { data, len }
}

/**
 * Van der Corput radical-inverse sequence, the building block of a Halton
 * sequence. Used for the per-frame sub-pixel jitter: a low-discrepancy sequence
 * covers the pixel far more evenly over a short window than white noise, so the
 * temporal average converges in fewer frames and without clumping.
 */
function radicalInverse(index, base) {
  let f = 1 / base
  let r = 0
  let i = index
  while (i > 0) {
    r += f * (i % base)
    i = Math.floor(i / base)
    f /= base
  }
  return r
}

// =============================================================================
// Screensaver
// =============================================================================

export default {
  name: 'Mandelbrot',

  create(canvas, seed) {
    // Built here rather than in start() so a stop/start cycle keeps the same
    // dive order, per the module contract in .claude/CLAUDE.md.
    const rng = createRng(seed)
    let targetIndex = rng.int(0, DIVE_TARGETS.length - 1)

    let runtime = null
    let prog = null
    let progU = null
    let resolve = null
    let resolveU = null
    let refTex = null
    let accumA = null
    let accumB = null
    let post = null

    // Dive state.
    let diveStart = 0
    let diveRate = 0
    let hueRot = 0
    let prevScale = 1
    let historyValid = false
    let maxIter = ITER_BASE
    let frameMs = TARGET_FRAME_MS
    let lastFrameAt = 0
    let sizeW = 0
    let sizeH = 0
    let refLen = REF_ORBIT_LEN
    let firstDive = true

    /** Start (or restart) a dive on the current target. */
    function beginDive(gl, time) {
      const t = DIVE_TARGETS[targetIndex]
      const orbit = referenceOrbit(t.x, t.y, REF_ORBIT_LEN)
      const rows = REF_ORBIT_LEN / REF_TEX_WIDTH
      gl.bindTexture(gl.TEXTURE_2D, refTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, REF_TEX_WIDTH, rows, 0,
        gl.RGBA, gl.FLOAT, orbit.data)
      // Curated targets never escape this early, but a truncated orbit would
      // otherwise be read as valid data, so the shader is told where it ends.
      refLen = orbit.len
      diveStart = time
      diveRate = rng.range(DIVE_RATE_MIN, DIVE_RATE_MAX)
      hueRot = rng.next()
      historyValid = false
      maxIter = ITER_BASE
    }

    /**
     * View half-height at a point in the dive, plus the crossfade level.
     *
     * The starting radius is chosen from the aspect ratio rather than fixed:
     * a half-height of 1.25 frames the whole set on a 16:9 monitor but leaves
     * the 5:1 wall four-fifths empty, so the wall instead opens on a horizontal
     * band cut through the set.
     */
    function diveState(elapsed, aspect) {
      const start = Math.min(1.25, 1.75 / Math.max(aspect, 0.1))
      // Ease-in: rate * (t - EASE_S * (1 - exp(-t/EASE_S))) leaves the origin
      // with zero slope and relaxes onto a constant exponential rate.
      const eased = elapsed - EASE_S * (1 - Math.exp(-elapsed / EASE_S))
      const log2Depth = Math.min(MAX_DIVE_LOG2, diveRate * eased)
      const diveLen = MAX_DIVE_LOG2 / diveRate + EASE_S
      // No fade-in on the very first dive: the screensaver has just replaced a
      // live input and should be there immediately. Later dives fade because
      // the cut between two unrelated coordinates is otherwise jarring.
      const fadeIn = firstDive ? 1 : Math.min(1, elapsed / FADE_S)
      const fadeOut = Math.min(1, Math.max(0, (diveLen + BOTTOM_HOLD_S + FADE_S - elapsed) / FADE_S))
      return {
        scale: start * Math.pow(2, -log2Depth),
        log2Depth,
        fade: fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut * fadeOut * (3 - 2 * fadeOut),
        done: elapsed > diveLen + BOTTOM_HOLD_S + FADE_S,
      }
    }

    /** Allocate (or reallocate) the accumulation ping-pong at the canvas size. */
    function sizeTargets(gl) {
      if (canvas.width === sizeW && canvas.height === sizeH) return
      sizeW = canvas.width
      sizeH = canvas.height
      if (accumA) accumA.resize(sizeW, sizeH)
      else accumA = createHdrColorTarget(gl, sizeW, sizeH)
      if (accumB) accumB.resize(sizeW, sizeH)
      else accumB = createHdrColorTarget(gl, sizeW, sizeH)
      historyValid = false
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        const gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        gl.getExtension('OES_texture_float_linear')

        prog = runtime.createQuadProgram(FRAGMENT_HEADER + FRACTAL_SHADER)
        prog.setSeed([rng.next(), rng.next(), rng.next(), rng.next()])
        progU = createUniformCache(gl, prog.program)
        resolve = createFullscreenPass(gl, RESOLVE_SHADER)
        resolveU = createUniformCache(gl, resolve.program)

        refTex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, refTex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

        runtime.resize()
        sizeTargets(gl)
        firstDive = true
        beginDive(gl, 0)
        lastFrameAt = 0
        frameMs = TARGET_FRAME_MS
        prevScale = diveState(0, canvas.width / Math.max(canvas.height, 1)).scale

        runtime.start((time, frame) => {
          sizeTargets(gl)
          const aspect = canvas.width / Math.max(canvas.height, 1)

          let state = diveState(time - diveStart, aspect)
          if (state.done) {
            // Never twice in a row: the dive is minutes long, and repeating one
            // is the single most noticeable way this could feel canned.
            targetIndex = (targetIndex + rng.int(1, DIVE_TARGETS.length - 1)) % DIVE_TARGETS.length
            firstDive = false
            beginDive(gl, time)
            state = diveState(0, aspect)
            prevScale = state.scale
          }

          // Without EXT_color_buffer_float there is no accumulation buffer and
          // no post chain, so the fractal goes straight to the 8-bit default
          // framebuffer: correct picture, no temporal supersampling and no dive
          // crossfade. Unreachable on any WebGL2 stack this app ships against;
          // it is here so a missing extension degrades rather than throws.
          const accumulate = accumA !== null && accumB !== null

          // Closed-loop iteration budget (#116). An EMA of measured frame time
          // moves the cap towards what the hardware sustains; the "wanted"
          // ceiling is what the current depth actually needs.
          const now = performance.now()
          if (lastFrameAt) frameMs = frameMs * 0.9 + Math.min(now - lastFrameAt, 500) * 0.1
          lastFrameAt = now
          const wanted = Math.min(REF_ORBIT_LEN - 2,
            ITER_BASE + ITER_PER_DOUBLING * state.log2Depth)
          const floor = Math.min(wanted,
            MIN_ITER_BASE + MIN_ITER_PER_DOUBLING * state.log2Depth)
          if (frameMs > TARGET_FRAME_MS * 1.15) maxIter *= 0.95
          else if (frameMs < TARGET_FRAME_MS * 0.85) maxIter *= 1.04
          maxIter = Math.max(floor, Math.min(wanted, maxIter))

          // Fractal + temporal blend into the write half of the ping-pong.
          gl.bindFramebuffer(gl.FRAMEBUFFER, accumulate ? accumB.fbo : null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          prog.draw(time, frame, () => {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, refTex)
            gl.uniform1i(progU('uRef'), 0)
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, accumulate ? accumA.tex : refTex)
            gl.uniform1i(progU('uHistory'), 1)
            gl.uniform1i(progU('uRefWidth'), REF_TEX_WIDTH)
            gl.uniform1i(progU('uRefLen'), refLen)
            gl.uniform1i(progU('uMaxIter'), Math.round(maxIter))
            gl.uniform1f(progU('uScale'), state.scale)
            gl.uniform1f(progU('uPrevScale'), prevScale)
            gl.uniform1f(progU('uHistoryBlend'), accumulate && historyValid ? HISTORY_WEIGHT : 0)
            gl.uniform2f(progU('uJitter'),
              accumulate ? radicalInverse(frame + 1, 2) - 0.5 : 0,
              accumulate ? radicalInverse(frame + 1, 3) - 0.5 : 0)
            gl.uniform1f(progU('uHueRot'), hueRot)
            gl.uniform1f(progU('uLumBoost'), luminanceScale(canvas))
            gl.activeTexture(gl.TEXTURE0)
          })
          prevScale = state.scale
          historyValid = true
          if (!accumulate) return

          // Resolve into the post chain (or straight to the screen for the few
          // frames before the chain finishes loading).
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)
          resolve.draw(() => {
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, accumB.tex)
            gl.uniform1i(resolveU('uSrc'), 0)
            gl.uniform2f(resolveU('uTexel'), 1 / canvas.width, 1 / canvas.height)
            gl.uniform1f(resolveU('uFade'), state.fade)
          })
          if (post) post.present()

          const swap = accumA
          accumA = accumB
          accumB = swap
        })

        // Bloom threshold sits just under the rim term, which is the only part
        // of the shader that exceeds 1.0 -- so the filigree glows and the
        // stripe-lit exterior does not.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 0.9, knee: 0.35, intensity: 0.5, radius: 1.0 },
          tonemap: 'aces',
          dither: true,
        })
      },

      stop() {
        if (post) { post.destroy(); post = null }
        if (resolve) { resolve.destroy(); resolve = null }
        if (prog) { prog.destroy(); prog = null }
        if (accumA) { accumA.destroy(); accumA = null }
        if (accumB) { accumB.destroy(); accumB = null }
        if (refTex && runtime) { runtime.gl.deleteTexture(refTex) }
        refTex = null
        if (runtime) { runtime.destroy(); runtime = null }
        sizeW = 0
        sizeH = 0
        progU = null
        resolveU = null
      },
    }
  },
}
