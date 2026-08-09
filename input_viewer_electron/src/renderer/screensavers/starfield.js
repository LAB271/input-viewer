// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Starfield warp — flying forward through a volume of stars, each drawn as a
 * motion-blurred streak radiating from the vanishing point (issues #58, #178).
 *
 * WHY THIS IS NOT A FRAGMENT SHADER ANY MORE
 *
 * The previous version searched a hashed cell grid per pixel: 14 depth layers
 * times 3 candidate stars, evaluated for every fragment. That bought at most 42
 * stars on screen for ~1700 ALU ops per pixel, which measured 27.8 ms/frame at
 * 6000x1200 on an M-series GPU -- over budget for 60 Hz -- and still read as
 * "roughly thirty white dashes on a navy field" at wall scale.
 *
 * Stars are geometry, not a field. One instanced quad per star (issue #116)
 * costs a handful of vertex ops per star and fill only where the star actually
 * is, so the count is bounded by how many you want rather than by how much
 * per-pixel search you can afford. It also hands you per-star colour, size,
 * streak length and brightness for free -- none of which the cell search could
 * express.
 *
 * PROJECTION
 *
 * Each star owns a fixed direction `q` in world space (aspect-corrected, so a
 * radius is a radius on a 5:1 wall -- issue #114) and a depth `z`. Its screen
 * position is `q / z`, so z = Z_REST puts the field exactly filling the frame
 * and every smaller z pushes it outward. Depth decreases with the camera's
 * travelled distance and wraps, re-hashing the direction on each wrap so the
 * tunnel never repeats.
 *
 * The consequence worth knowing: at depth z only about (z/Z_REST)^2 of the
 * stars are still on screen, so roughly a third of the instances are visible at
 * any moment and the rest are cheap off-screen quads. That is not waste, it is
 * the perspective: the sky is dense with far stars and sparse with near ones.
 *
 * Per-activation variation (seeded RNG): cruise speed, the burst schedule, the
 * vanishing point and its drift, star density jitter, and the nebula's hue,
 * offset and zoom phase.
 */
import {
  createGLRuntime, createFullscreenPass, buildProgram, pointScale, luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache, canvasAspect, createInstancedQuads } from './glsl-lib.js'
import { createPostChain } from './post-fx.js'
import { createRng } from './seed.js'

// ---------------------------------------------------------------------------
// Geometry of the tunnel
// ---------------------------------------------------------------------------

// Depth at which a star sits exactly where its direction vector says, i.e. the
// depth at which the whole field covers the frame once. Fixing it at 1.0 makes
// every other depth constant read as a multiple of "one screen".
const Z_REST = 1.0

// Closest approach before a star recycles. At z = 0.035 a star is 28x further
// from the vanishing point than at rest, so all but the ones aimed almost
// straight at the camera have long since left the frame; going closer buys
// nothing and costs precision in the 1/z divide.
const Z_NEAR = 0.035
const Z_SPAN = Z_REST - Z_NEAR

// Persistence window the streaks represent, in seconds. This is the one number
// that sets how "warp" it looks: 0.055 s is roughly the eye's own integration
// time, so at cruise the streaks are short dashes and during a burst they pull
// out across the wall without any separate effect being switched on.
const EXPOSURE_S = 0.055

// Longest streak we will draw, in world units (1.0 = the short axis of the
// display). The wall is 5 units wide, so 6.0 lets a close pass genuinely cross
// it while bounding the fill cost of a single quad during a burst.
const MAX_STREAK = 6.0

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

// Stars per megapixel of canvas. The old saver's density was a fixed cell
// count, so the wall (7.2 MP, 3.5x of 1080p) got the same few dozen stars as a
// preview window and read as an empty screen -- the headline complaint in #178.
// Tying the count to area holds density constant instead: ~3.1k instances at
// 1080p, ~11k on the wall, of which roughly a third are on screen.
//
// Tuned down from a first pass at 5800, which filled the wall edge to edge with
// dashes: a blizzard, not a sky. Density has an optimum and it is well below
// "as many as the GPU will take".
const STARS_PER_MEGAPIXEL = 1500
const MIN_STARS = 1800
// Cost ceiling. 64k instances is 384k vertices per frame, which is nothing for
// a GPU, but it also bounds worst-case fill if a burst stretches many streaks
// at once.
const MAX_STARS = 64000

// ---------------------------------------------------------------------------
// Warp dynamics
// ---------------------------------------------------------------------------

// Cruise speed in depth units per second. At 0.3 a star crosses the whole
// tunnel in ~3 s, which at the 1/z^2 radial law means a lazy drift far out and
// a fast exit near the camera.
const CRUISE_MIN = 0.22
const CRUISE_MAX = 0.40

// Jump-to-lightspeed bursts. A constant speed reads as a screensaver; the
// 10-minute rotation slot means somebody will watch this long enough to notice
// that nothing ever happens. Ramp, hold and fall are asymmetric on purpose --
// acceleration should feel like a decision and deceleration like coasting.
const BURST_RAMP_S = 1.4
const BURST_HOLD_S = 2.2
const BURST_FALL_S = 9.0
const BURST_TOTAL_S = BURST_RAMP_S + BURST_HOLD_S + BURST_FALL_S
const BURST_PEAK_MIN = 3.2
const BURST_PEAK_MAX = 6.5
// Gap between bursts. Long enough that a burst is an event rather than a tic,
// short enough that a 10-minute slot contains several.
const BURST_GAP_MIN = 50
const BURST_GAP_MAX = 135
// Enough scheduled bursts to outlast any plausible slot (24 x ~90 s average is
// over half an hour), computed up front so a start/stop/start replays the same
// journey rather than drawing fresh randoms mid-flight.
const BURST_COUNT = 24

// ---------------------------------------------------------------------------
// Photometry
// ---------------------------------------------------------------------------

// Flux of a median star at rest depth, in HDR linear units. Everything else
// scales off this: brightness goes as BASE_FLUX / z^2, so a star at z = 0.2
// is 25x this before the motion-blur spread takes its cut.
const BASE_FLUX = 0.13

// How much of the motion-blur energy spread to apply, in [0,1].
//
// Physically it should be 1.0, and the reason is a pretty cancellation: a star
// approaching at speed v deposits its light over a screen length that grows as
// 1/z^2, while its flux grows as 1/z^2, so the *surface* brightness of a warp
// streak is independent of depth. Exactly right, and visually dead -- with full
// conservation every streak is the same brightness and only length carries the
// depth cue. At 0.4 the near stars still brighten as roughly 1/z^1.2, which is
// the depth read the eye wants, while long burst streaks still dim honestly
// instead of turning into white bars.
const SPREAD_ALPHA = 0.4

// Fraction of stars flagged as close, bright "hero" passes. At 0.6% of ~42k
// stars there are a couple of hundred of them in the volume, but only the
// handful that happen to be near the camera *and* aimed near the frame are
// visible -- which works out at one every few seconds.
const HERO_FRACTION = 0.006
const HERO_FLUX = 5.0
const HERO_SIZE = 1.7

// Core radius of a star at rest depth, in pixels at 1080p, before pointScale
// lifts it for a large display. Below about 1.5 px a moving highlight crawls
// between pixels and reads as flicker rather than as a star.
const CORE_PX = 1.6

// ---------------------------------------------------------------------------
// Nebula
// ---------------------------------------------------------------------------

// Pattern scale of the dust at zoom phase 0, in world units. 0.75 puts about
// four cloud-sized features across a 5:1 frame, which leaves genuine negative
// space rather than an even wall of texture.
const NEB_SCALE = 1.1
// Zoom cycles per unit of travelled distance. At cruise this is one cycle every
// ~4 minutes: the dust is far away, so it must parallax an order of magnitude
// slower than the stars or it reads as fog attached to the camera.
const NEB_RATE = 0.012
// Peak HDR luminance of the cloud. Sized so the brightest wisps sit well under
// a mid-range star and most of the frame stays at true black -- the background
// is black here, and the washout headroom comes from the stars (undoing the
// flat navy lift that #178 called out).
const NEB_GAIN = 0.030

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Dust and nebula, drawn first and opaque so it also clears the frame.
//
// Endless zoom by the standard two-layer trick: both layers run the same
// scale ramp over one octave, offset half a cycle apart, cross-faded with a
// triangle that is exactly zero where a layer resets. The two are sampled at
// different offsets as well as different scales, so the superposition reads as
// two clouds at different distances rather than one cloud zooming.
const NEBULA_FRAG = /* glsl */ `#version 300 es
precision highp float;

${GLSL.simplex2d}
${GLSL.fbm}
${GLSL.palette}
${GLSL.worldSpace}

uniform vec2 uResolution;
uniform vec2 uCentre;
uniform vec2 uOffsetA;
uniform vec2 uOffsetB;
uniform float uPhase;    // zoom phase of layer A, in [0,1)
uniform float uHue;
uniform float uGain;
out vec4 outColor;

vec3 cloud(vec2 q, float phase, vec2 offset) {
  // Scale shrinks as the phase advances, so features grow outward from the
  // vanishing point -- the same direction the stars travel, an octave slower.
  vec2 p = q * (${NEB_SCALE.toFixed(3)} * exp2(-phase)) + offset;

  // Domain warp before the fbm. Straight fbm gives cotton-wool blobs; warping
  // the sample point by another noise field is what produces the filaments and
  // voids that make it read as gas.
  vec2 w = vec2(snoise(p * 0.9), snoise(p * 0.9 + 17.3));
  float n = fbm(p + w * 0.75, 3);

  // Hard shaping. A gentle ramp here is exactly how a nebula becomes a flat
  // wash: raising a thresholded density to a power keeps the bright filaments
  // and sends everything below the threshold to zero, which is where the
  // negative space comes from. The first pass used smoothstep(0.05, 0.55) and
  // squaring, and it read as brown smoke filling the frame.
  float density = smoothstep(0.12, 0.62, n);
  density = density * density * density;

  // Hue rides the warp field, so the cloud shifts through teal and violet
  // across its own structure instead of being one tinted fog. OKLab keeps the
  // lightness steady while the hue moves (no lightness pulsing, issue #115).
  return oklabRamp(uHue + 0.10 * w.x, 0.62, 0.13, 0.0) * density;
}

void main() {
  vec2 q = worldFromFrag(gl_FragCoord.xy, uResolution) - uCentre;
  float phaseB = fract(uPhase + 0.5);
  // Triangle weights peaking mid-cycle. They sum to 1 for any phase, so the
  // cloud neither pulses nor dips as the layers hand over.
  float wA = 1.0 - abs(2.0 * uPhase - 1.0);
  float wB = 1.0 - abs(2.0 * phaseB - 1.0);
  vec3 col = cloud(q, uPhase, uOffsetA) * wA + cloud(q, phaseB, uOffsetB) * wB;
  outColor = vec4(col * uGain, 1.0);
}`

// One instanced quad per star, oriented along and stretched to cover the
// streak between the star's position one persistence window ago and now.
const STAR_VERT = /* glsl */ `#version 300 es
precision highp float;

${GLSL.hash}
${GLSL.worldSpace}

in vec2 aCorner;

uniform float uAspect;
uniform vec2 uCentre;
uniform float uWrapped;   // travelled distance modulo Z_SPAN
uniform float uCycle;     // completed wraps, kept on the CPU for precision
uniform float uSpeed;     // current warp speed, depth units per second
uniform float uCore;      // star core radius in world units
uniform float uGain;      // large-display luminance boost
uniform uint uSeedId;

out vec2 vLocal;          // world units: x along the streak, y across it
out float vHalfSeg;
out float vSize;
out float vDecay;
out vec3 vColor;

// One hash chain per star, drawn from in sequence. Cheaper and less
// error-prone than inventing a decorrelated constant per attribute.
uint rngState;
float nextRand() { rngState = hashU(rngState); return hashF(rngState); }

// Blackbody colour: CIE xy on the Planckian locus by the Kang et al. (2002)
// fit, then xyY -> XYZ -> linear sRGB. Ported rather than invented; the
// alternative eyeballed blue-to-amber lerp is what the old shader did and it
// gives a magenta-ish midpoint that no real star has.
//
// Only the two upper temperature branches of the fit are included: the field
// starts at 3200 K, so the 1667-2222 K branch can never be reached.
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 2222.0, 25000.0);
  float u = 1000.0 / t;
  float x = t < 4000.0
    ? -0.2661239 * u * u * u - 0.2343589 * u * u + 0.8776956 * u + 0.179910
    : -3.0258469 * u * u * u + 2.1070379 * u * u + 0.2226347 * u + 0.240390;
  float y = t < 4000.0
    ? -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
    : 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;

  vec3 xyz = vec3(x / y, 1.0, (1.0 - x - y) / y);
  vec3 rgb = vec3(
    3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z,
    -0.9692660 * xyz.x + 1.8760108 * xyz.y + 0.0415560 * xyz.z,
    0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z);
  rgb = max(rgb, 0.0);
  // Normalise to peak channel rather than to luminance, so the temperature
  // controls hue only and the flux term below is the sole owner of brightness.
  rgb /= max(max(rgb.r, max(rgb.g, rgb.b)), 1e-4);
  // Deliberate saturation stretch. A physically exact 3000-11000 K spread is
  // subtle, and what survives an ACES curve plus a bloom halo at wall viewing
  // distance is subtler still -- the first pass looked like a field of white
  // dots. Raising the normalised channels to a power leaves the peak at 1.0
  // and pulls the others down, so the hue is exaggerated without any star
  // changing brightness.
  return pow(rgb, vec3(1.45));
}

void main() {
  uint id = uint(gl_InstanceID);

  // Draws that must survive a wrap: depth offset, temperature, size and the
  // hero flag belong to the star, not to its current pass.
  rngState = hashU(uvec2(id, uSeedId));
  float z0 = nextRand() * ${Z_SPAN.toFixed(4)};
  float tempR = nextRand();
  float sizeR = nextRand();
  float fluxR = nextRand();
  float hero = step(${(1.0 - HERO_FRACTION).toFixed(4)}, nextRand());

  // Depth. uWrapped rises through one span and resets, with the whole-span
  // count carried separately, so travelling for ten minutes never eats into
  // the mantissa of the subtraction the way a monotonic distance would.
  float d = z0 - uWrapped;
  float extraCycle = d < 0.0 ? 1.0 : 0.0;
  d += extraCycle * ${Z_SPAN.toFixed(4)};
  float z = ${Z_NEAR.toFixed(4)} + d;

  // Direction is re-hashed on every wrap, so the tunnel is genuinely endless
  // rather than a loop of the same few thousand rays. Safe to do at the wrap
  // point because that is where the star is furthest away and dimmest.
  rngState = hashU(uvec3(id, uint(uCycle + extraCycle), uSeedId));
  // Placed across the frame rather than in a square: on a 5:1 wall a square
  // placement would leave the far field bunched in the middle fifth.
  vec2 ext = worldExtent(uAspect) * 1.06;
  vec2 q = (vec2(nextRand(), nextRand()) * 2.0 - 1.0) * ext;

  // The streak is where this star was one persistence window ago -- further
  // away, therefore closer to the vanishing point -- to where it is now.
  vec2 pNow = q / z + uCentre;
  vec2 pPrev = q / (z + uSpeed * ${EXPOSURE_S.toFixed(4)}) + uCentre;
  vec2 axis = pNow - pPrev;
  float rawLen = length(axis);
  vec2 dir = rawLen > 1e-6 ? axis / rawLen : vec2(1.0, 0.0);
  float segLen = min(rawLen, ${MAX_STREAK.toFixed(2)});
  // Clamp from the tail, keeping the head at the star's true position.
  vec2 mid = pNow - dir * (segLen * 0.5);

  // Size: mostly the depth cue that survives when a star is only a few pixels
  // across. The exponent is well under 1 because a star is a point source --
  // what grows with proximity is the apparent glare, not the disc.
  float size = uCore * mix(0.8, 1.45, sizeR)
             * clamp(pow(${Z_REST.toFixed(1)} / z, 0.42), 1.0, 3.2)
             * mix(1.0, ${HERO_SIZE.toFixed(2)}, hero);

  // Temperature. Biased hot: the exponent below 1 pushes the median to about
  // 8000 K (blue-white) while leaving a long amber tail, which is the spread
  // that reads as a star field rather than as a colour wheel.
  float kelvin = mix(3200.0, 11000.0, pow(tempR, 0.7));
  // Hotter stars are intrinsically more luminous. The real main-sequence
  // relation is nearer L ~ T^5, which would make every blue star a searchlight
  // and every red one invisible; 1.3 keeps the correlation legible.
  float tempLum = pow(kelvin / 6500.0, 1.3);

  float flux = ${BASE_FLUX.toFixed(3)} * mix(0.35, 1.8, fluxR) * tempLum
             * mix(1.0, ${HERO_FLUX.toFixed(1)}, hero) * uGain / (z * z);

  // Motion blur spreads a fixed amount of light over the streak, so a longer
  // streak is a dimmer one. See SPREAD_ALPHA for why this is deliberately
  // partial rather than energy-exact.
  float spread = pow((2.0 * size) / (2.0 * size + segLen), ${SPREAD_ALPHA.toFixed(2)});

  // Fade in at the wrap and out at closest approach, so nothing pops.
  float fadeFar = smoothstep(${Z_REST.toFixed(2)}, ${(Z_REST - 0.12).toFixed(2)}, z);
  float fadeNear = smoothstep(${Z_NEAR.toFixed(4)}, ${(Z_NEAR * 2.4).toFixed(4)}, z);

  vColor = blackbody(kelvin) * flux * spread * fadeFar * fadeNear;

  // Tail falloff. Within a single exposure the deposit really is uniform (that
  // is the cancellation in SPREAD_ALPHA's note), so this taper is persistence
  // of vision rather than exposure: the tail is older light and has decayed.
  // Only applied once a streak is meaningfully longer than the core, otherwise
  // a distant star would be a lopsided dot.
  vDecay = 1.7 * smoothstep(size * 1.5, size * 6.0, segLen);

  // The quad: half a streak plus two core radii of slack at each end, so the
  // Gaussian below has faded to nothing before it reaches the geometry edge.
  vec2 perp = vec2(-dir.y, dir.x);
  float halfAlong = segLen * 0.5 + size * 2.0;
  float halfAcross = size * 2.0;
  vLocal = vec2(aCorner.x * 2.0 * halfAlong, aCorner.y * 2.0 * halfAcross);
  vHalfSeg = segLen * 0.5;
  vSize = size;
  gl_Position = clipFromWorld(mid + dir * vLocal.x + perp * vLocal.y, uAspect);
}`

const STAR_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vHalfSeg;
in float vSize;
in float vDecay;
in vec3 vColor;
out vec4 outColor;

void main() {
  // Distance to the streak's centre line as a capsule: zero along the segment,
  // then radial at the caps. This is what makes the ends round rather than the
  // chopped-off rectangles the old shader drew.
  float dx = max(abs(vLocal.x) - vHalfSeg, 0.0);
  float d2 = (dx * dx + vLocal.y * vLocal.y) / (vSize * vSize);

  // Two Gaussians: a wide one for the halo and a tight one for the core. A
  // single Gaussian either looks like a soft blob or like a hard dot; the sum
  // gives the sharp centre with a skirt that the bloom pass can pick up.
  float core = exp(-3.0 * d2) + 0.5 * exp(-14.0 * d2);

  float along = vHalfSeg > 1e-6 ? clamp(vLocal.x / vHalfSeg, -1.0, 1.0) * 0.5 + 0.5 : 1.0;
  outColor = vec4(vColor * core * exp(-(1.0 - along) * vDecay), 1.0);
}`

/** Smootherstep on [0,1]; C2 at both ends, so a burst has no velocity kink. */
function ease(x) {
  const t = Math.min(1, Math.max(0, x))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export default {
  name: 'Starfield Warp',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let nebula = null, starProg = null, quads = null, post = null
    let stars = MIN_STARS
    let aspect = 1

    // Drawn in create(), not start(): a start/stop/start cycle should resume
    // the same journey rather than re-roll the whole flight plan.
    const rng = createRng(seedValue)
    const cruise = rng.range(CRUISE_MIN, CRUISE_MAX)
    // Two decorrelated slow sinusoids, so the "breathing" between bursts never
    // settles into an obvious period. Amplitudes sum to 0.46, keeping the
    // factor in [0.54, 1.46] -- audible as acceleration, never as a stall.
    const breathe = [rng.phase(), rng.phase()]
    // Vanishing point. A static per-activation offset plus a slow drift: on a
    // 5:1 canvas an off-centre vanishing point is most of what makes one
    // activation look different from the last.
    const centre0 = [rng.around(0, 0.55), rng.around(0, 0.10)]
    const drift = [rng.range(0.12, 0.28), rng.range(0.03, 0.07)]
    const driftPhase = [rng.phase(), rng.phase()]
    // Density jitter, so two activations differ in how crowded the sky is.
    const densityMul = rng.range(0.8, 1.25)
    // Hue restricted to the cool arc of the OKLab wheel: 0.62 is teal, 0.75
    // blue, 0.95 magenta. Left unrestricted the first version drew an orange
    // cloud, which does not read as a nebula behind a star field -- it reads as
    // rust. Emission nebulae are of course often red, but red plus warm stars
    // plus ACES is a muddy frame, and the cool arc keeps the amber stars as the
    // only warm thing on the wall.
    const nebHue = rng.range(0.62, 0.95)
    const nebOffsetA = [rng.range(-40, 40), rng.range(-40, 40)]
    const nebOffsetB = [rng.range(-40, 40), rng.range(-40, 40)]
    const nebPhase0 = rng.next()
    const seedId = Math.floor(rng.next() * 4294967296) >>> 0

    // Burst schedule, precomputed for the same reason the rest is: no RNG draws
    // inside the frame loop.
    const bursts = []
    let at = rng.range(20, 55)
    for (let i = 0; i < BURST_COUNT; i++) {
      bursts.push({ at, peak: rng.range(BURST_PEAK_MIN, BURST_PEAK_MAX) })
      at += rng.range(BURST_GAP_MIN, BURST_GAP_MAX)
    }

    // Flight state. travel is an accumulated distance rather than a function of
    // time, because the speed varies -- integrating it is the only way the
    // field stays continuous across an acceleration.
    let travel = 0
    let burstIndex = 0

    /** Speed multiplier from the burst schedule at wall-clock time t. */
    function burstFactor(t) {
      while (burstIndex < bursts.length - 1 && t > bursts[burstIndex].at + BURST_TOTAL_S) {
        burstIndex++
      }
      const b = bursts[burstIndex]
      const dt = t - b.at
      if (dt < 0 || dt > BURST_TOTAL_S) return 1
      if (dt < BURST_RAMP_S) return 1 + (b.peak - 1) * ease(dt / BURST_RAMP_S)
      if (dt < BURST_RAMP_S + BURST_HOLD_S) return b.peak
      return 1 + (b.peak - 1) * (1 - ease((dt - BURST_RAMP_S - BURST_HOLD_S) / BURST_FALL_S))
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        // createGLRuntime has sized the canvas, so area-based scaling is valid.
        aspect = canvasAspect(canvas)
        const megapixels = (canvas.width * canvas.height) / 1e6
        stars = Math.max(MIN_STARS, Math.min(MAX_STARS,
          Math.round(megapixels * STARS_PER_MEGAPIXEL * densityMul)))

        travel = 0
        burstIndex = 0

        nebula = createFullscreenPass(gl, NEBULA_FRAG)
        starProg = buildProgram(gl, STAR_VERT, STAR_FRAG)
        quads = createInstancedQuads(gl, starProg.program)
        const uNeb = createUniformCache(gl, nebula.program)
        const uStar = createUniformCache(gl, starProg.program)

        // HDR scene target, bloom, ACES and dither (issues #112, #140). The
        // stars are written as true HDR -- a near star peaks well past 1.0 --
        // so the threshold is set from a measurement of the scene target, not
        // from a round number: at 6000x1200 the 99.9th percentile is ~0.9 and
        // the peak ~13, so 0.85 selects the near field and the hot stars while
        // leaving the far dust alone. See the HDR-vs-LDR note in post-fx.js.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 0.85, knee: 0.35, intensity: 0.55, radius: 1.0 },
          tonemap: 'aces',
          dither: true
        })

        runtime.start((time, frameCount, glCtx, rt) => {
          const speed = cruise
            * (1 + 0.30 * Math.sin(time * 0.041 + breathe[0])
                 + 0.16 * Math.sin(time * 0.017 + breathe[1]))
            * burstFactor(time)
          travel += speed * rt.dt

          const cycle = Math.floor(travel / Z_SPAN)
          const wrapped = travel - cycle * Z_SPAN
          const cx = centre0[0] + Math.sin(time * 0.043 + driftPhase[0]) * drift[0]
          const cy = centre0[1] + Math.cos(time * 0.037 + driftPhase[1]) * drift[1]

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)

          // Dust first, opaque: it doubles as the clear, and drawing it into
          // the same HDR target means the bloom sees it too.
          gl.disable(gl.BLEND)
          nebula.draw((g) => {
            g.uniform2f(uNeb('uResolution'), canvas.width, canvas.height)
            g.uniform2f(uNeb('uCentre'), cx, cy)
            g.uniform2f(uNeb('uOffsetA'), nebOffsetA[0], nebOffsetA[1])
            g.uniform2f(uNeb('uOffsetB'), nebOffsetB[0], nebOffsetB[1])
            g.uniform1f(uNeb('uPhase'), (nebPhase0 + travel * NEB_RATE) % 1)
            g.uniform1f(uNeb('uHue'), nebHue)
            g.uniform1f(uNeb('uGain'), NEB_GAIN * luminanceScale(canvas))
          })

          // Stars accumulate: overlapping streaks should sum, which is what
          // makes a crowded patch of sky genuinely brighter than a lone star
          // and gives the bloom something real to select.
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.ONE, gl.ONE)
          gl.useProgram(starProg.program)
          gl.uniform1f(uStar('uAspect'), aspect)
          gl.uniform2f(uStar('uCentre'), cx, cy)
          gl.uniform1f(uStar('uWrapped'), wrapped)
          gl.uniform1f(uStar('uCycle'), cycle)
          gl.uniform1f(uStar('uSpeed'), speed)
          // World units, since world y spans exactly 1.0 over the canvas height.
          gl.uniform1f(uStar('uCore'),
            (CORE_PX * pointScale(canvas, CORE_PX)) / canvas.height)
          gl.uniform1f(uStar('uGain'), luminanceScale(canvas))
          gl.uniform1ui(uStar('uSeedId'), seedId)
          quads.draw(stars)
          gl.disable(gl.BLEND)

          if (post) post.present()
        })
      },
      stop() {
        if (nebula) { nebula.destroy(); nebula = null }
        if (starProg) { starProg.destroy(); starProg = null }
        if (quads) { quads.destroy(); quads = null }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
