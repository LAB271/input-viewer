// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Raymarched Mandelbulb — a slowly morphing fractal solid, lit by a low sun
 * over a dark reflective plain, under a twilight sky (issue #120).
 *
 * This is the one saver that renders actual *geometry*, so it is the one where
 * standard SDF rendering practice pays off most. It now has the four things
 * that make a raymarched surface read as solid rather than as a shaded blob:
 * penumbra-tracking soft shadows, multi-tap ambient occlusion, a real
 * environment used both as background and as the ambient/IBL source, and
 * Fresnel-weighted reflections marched against the same field. Plus a
 * translucency term, because a Mandelbulb's thin lobes look extraordinary
 * back-lit, and orbit-trap colouring, because `length(p)` is a radial gradient
 * that throws away every bit of internal structure the iteration computed.
 *
 * WHY THIS SAVER DRIVES ITS OWN LOOP INSTEAD OF createShaderScreensaver
 *
 * The top defect on the wall was not aliasing but *shimmer*: the camera orbits
 * continuously, so the noisy distance-estimator edges reprojected differently
 * every frame and the silhouette crawled. Spatial supersampling alone does not
 * fix that -- it makes each frame smoother without making consecutive frames
 * agree. The fix is temporal: jitter the sub-pixel sample position per frame
 * and accumulate in the HDR buffer, which converges to a properly box-filtered
 * image and averages away exactly the frame-to-frame disagreement.
 *
 * createShaderScreensaver draws opaquely into the post chain's scene target, so
 * it cannot accumulate. Here the same target is blended into with a constant
 * alpha instead, which costs no extra passes and no extra textures: the HDR
 * scene target *is* the history buffer.
 *
 * The blend weight is derived from unclamped wall-clock dt
 * (fadeAlphaForHalfLife), not from a fixed per-frame constant. That keeps the
 * history length in seconds rather than in frames -- the same reason trails are
 * wall-clock elsewhere in this codebase -- and it has a useful side effect: on a
 * slow renderer, where a frame takes over a second, the weight goes to 1.0 and
 * the accumulation switches itself off rather than smearing a camera that has
 * jumped a long way between frames.
 *
 * WHAT IT COSTS
 *
 * 18.4 fps at 6000x1200 on a real GPU (ANGLE/Metal, M3 Pro, 15s, seed 4242) --
 * the second-slowest saver in the set, and below the ~30 fps a videowall wants.
 * Measured in #225, which was the first time anything here was measured at the
 * resolution the app actually runs at.
 *
 * An earlier version of this comment claimed this "costs less than the version it
 * replaces, despite doing far more". DO NOT RELY ON THAT: the comparison was never
 * measured. The old version's cost was never recorded at any resolution, and this
 * one was only ever measured at 3000x600 -- a quarter of the pixels -- until #225.
 *
 * The two optimisations behind that claim are real, and worth knowing before
 * touching anything here. They simply do not add up to a verified saving:
 *
 *   - a bounding-sphere test skips the march entirely for the ~85% of a 5:1 frame
 *     the bulb does not cover, where the old one marched 90 steps x 8 DE
 *     iterations for *every* pixel including empty sky;
 *   - secondary rays (shadow, AO, reflection) run a 5-iteration DE rather than
 *     the full 8.
 *
 * The likely cost centre at wall resolution is the temporal accumulation above:
 * it blends into a canvas-sized HDR target every frame, which is cheap at 1.8M
 * pixels and much less so at 7.2M. Decoupling that target from canvas size is the
 * first thing to try, and it is what #225 proposes.
 */
import {
  createGLRuntime, fadeAlphaForHalfLife, isBigRoomDisplay
} from './gl-base.js'
import { GLSL } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

const SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 iResolution;
uniform float iTime;
uniform int iFrame;
uniform vec4 iSeed;
// Sub-pixel offset for this frame, in pixels, from an R2 low-discrepancy
// sequence on the JS side. A random offset would clump; R2 guarantees that any
// prefix of the sequence is well spread over the pixel, so the temporal average
// converges quickly instead of wandering.
uniform vec2 uJitter;
out vec4 outColor;

${GLSL.hash}
${GLSL.simplex2d}
${GLSL.palette}

// ---------------------------------------------------------------- constants

// Bounding sphere of the Mandelbulb attractor. The escape radius is 2.0, but
// the solid itself never leaves ~1.25 for powers in the 4..9 range this saver
// sweeps; 1.32 leaves margin for the fattening that fewer DE iterations cause
// on the secondary rays.
const float BOUND_R = 1.32;
// Ground plane height. Sits just under the bulb's lowest lobe so the contact
// shadow is tight rather than a detached smudge.
const float GROUND_Y = -1.55;
// Focal length in uv units (uv.y spans [-0.5, 0.5]), i.e. a 28 degree vertical
// field of view. Wider looks fine at 16:9 and becomes grotesque at 5:1, where
// the horizontal field is already ~102 degrees and the corners stretch.
const float FOCAL = 2.0;
const float FAR = 40.0;

// Distance-estimator iteration counts. 8 resolves the surface detail the
// primary ray actually needs; 5 is a deliberately coarser, slightly fatter
// version of the same solid, which is all a shadow, an occlusion tap or a
// blurred reflection can distinguish. Halving the trig work on those rays is
// what pays for having three of them.
//
// STEP AND ITERATION BUDGETS, MEASURED AT 6000x1200 (#225)
//
// These were all reduced together, and that word matters: measured individually
// at wall resolution, most of them do nothing at all.
//
//   baseline (110/26/40, DE 8/5, eps 0.55)          16.3 fps
//   DE_FINE 6 alone                                 16.3
//   PRIMARY_STEPS 70 alone                          16.4
//   SHADOW 16 + REFLECT 22                          17.7
//   all of the above + eps 1.2                      25.5
//   this file (64/12/16, DE 6/4, eps 1.6)           31.3
//
// A 92% gain from changes that are worth nothing on their own is not an
// iteration-count effect. It reads as occupancy: the loop bounds are compile-time
// constants, so lowering them together lets the compiler hold the shader in fewer
// registers and run more threads in flight. Anyone tuning these should therefore
// change them as a set and measure the set -- reverting one "because it made no
// difference" will silently cost most of the gain.
const int DE_FINE = 6;
const int DE_COARSE = 4;

const int PRIMARY_STEPS = 64;
const int SHADOW_STEPS = 12;
const int REFLECT_STEPS = 16;

// ---------------------------------------------------------------- geometry

// Ray/sphere, returning (near, far). near > far means a miss.
//
// This is the single biggest saving in the rewrite. The previous version ran
// the full 90-step march for background rays too, which on a 5:1 frame is most
// of the screen; now they cost one dot product.
vec2 boundingSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Mandelbulb distance estimator with orbit traps.
//
// trap.xyz collect the per-axis minima of |z| over the orbit and trap.w the
// minimum radius. Those minima vary in fine self-similar bands over the
// surface, which is the intricate internal structure fractal renders are prized
// for -- and precisely what the old length(p) colouring discarded in favour of
// a radial gradient.
float bulbDE(vec3 pos, float power, int iters, out vec4 trap) {
  vec3 z = pos;
  float dr = 1.0;
  float r = 0.0;
  trap = vec4(1e10);
  for (int i = 0; i < iters; i++) {
    r = length(z);
    if (r > 2.0) break;
    trap = min(trap, vec4(abs(z), r));
    // clamp() guards acos against the |z.z/r| > 1 that rounding produces when z
    // is nearly axis-aligned; unclamped it returns NaN, which then propagates
    // through the whole shade.
    float theta = acos(clamp(z.z / max(r, 1e-9), -1.0, 1.0));
    float phi = atan(z.y, z.x);
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    float zr = pow(r, power);
    theta *= power;
    phi *= power;
    z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
    z += pos;
  }
  // max() keeps log() away from zero at the exact origin, where r is 0 and the
  // estimator is undefined.
  return 0.5 * log(max(r, 1e-6)) * r / dr;
}

float bulbDE(vec3 pos, float power, int iters) {
  vec4 ignored;
  return bulbDE(pos, power, iters, ignored);
}

// Central-difference normal with a caller-supplied epsilon.
//
// The old version hardcoded 0.001 regardless of depth, so distant surfaces --
// where 0.001 is far below a pixel footprint -- sampled pure DE noise and their
// normals degraded into speckle. Scaling the offset with the cone footprint
// makes the normal describe the surface at the resolution actually being shown.
vec3 calcNormal(vec3 p, float power, float eps) {
  vec2 e = vec2(eps, 0.0);
  vec3 g = vec3(
    bulbDE(p + e.xyy, power, DE_FINE) - bulbDE(p - e.xyy, power, DE_FINE),
    bulbDE(p + e.yxy, power, DE_FINE) - bulbDE(p - e.yxy, power, DE_FINE),
    bulbDE(p + e.yyx, power, DE_FINE) - bulbDE(p - e.yyx, power, DE_FINE)
  );
  // Guard the zero gradient. Deep inside the bulb the DE saturates and all six
  // samples come back equal, so g is exactly zero and normalize() returns NaN
  // (found on real hardware, not on SwiftShader -- see issue #140).
  float len = length(g);
  return len > 1e-12 ? g / len : vec3(0.0, 1.0, 0.0);
}

// Quilez's penumbra-tracking soft shadow.
//
// The classic version returns min(k*h/t) along the ray, which over-darkens
// because h is the distance to the *nearest* surface rather than the closest
// approach to the ray itself. This one corrects for that using the previous
// step, so the penumbra widens with the occluder distance the way a real one
// does. That gradient is most of what sells a raymarched solid as solid.
float softShadow(vec3 ro, vec3 rd, float tmin, float tmax, float k, float power) {
  // Clip the shadow ray to the bulb's bounding sphere before marching. The
  // second reason is the important one: a light ray that never approaches the
  // fractal now returns exactly 1.0, instead of whatever a fixed 26-step budget
  // happened to reach. Without this the plain showed concentric terraced arcs
  // where the budget ran out at different distances -- the textbook
  // under-marched-shadow artifact, and clearly visible at 5:1.
  vec2 bs = boundingSphere(ro, rd, BOUND_R);
  if (bs.x > bs.y || bs.y <= tmin) return 1.0;
  float tEnd = min(tmax, bs.y);
  float t = max(tmin, bs.x);
  float res = 1.0;
  float ph = 1e20;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    float h = bulbDE(ro + rd * t, power, DE_COARSE);
    if (h < 0.0015) return 0.0;
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, k * d / max(1e-4, t - y));
    ph = h;
    t += h * 0.9;
    if (t > tEnd) break;
  }
  return clamp(res, 0.0, 1.0);
}

// Ambient occlusion and translucency thickness from one shared set of taps.
//
// AO is Quilez's calcAO: step out along the normal and compare the actual field
// value with the distance stepped -- where the field is closer than it should
// be, something is in the way. On a fractal, which is all crevice, this carries
// an enormous share of the form; without it the bulb reads as a lumpy ball.
//
// Thickness steps the same distances *inward*. The Mandelbulb estimator goes
// negative inside the solid, so a tap that stays negative means the material is
// still thick there and a tap that turns positive means the lobe is thin. Used
// below to bleed light through the thin structures.
void aoAndThickness(vec3 p, vec3 n, float power, out float ao, out float thick) {
  float occ = 0.0;
  float sca = 1.0;
  float th = 0.0;
  float thNorm = 0.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.008 + 0.10 * float(i) / 4.0;
    occ += (h - bulbDE(p + n * h, power, DE_COARSE)) * sca;
    sca *= 0.85;
    if (i < 3) {
      th += clamp(h - bulbDE(p - n * h, power, DE_COARSE), 0.0, h);
      thNorm += h;
    }
  }
  ao = clamp(1.0 - 1.7 * occ, 0.0, 1.0);
  thick = clamp(th / max(thNorm, 1e-4), 0.0, 1.0);
}

// ---------------------------------------------------------------- environment

// Sparse starfield on a spherical lattice.
//
// The radius is floored at the pixel footprint: a star smaller than a pixel is
// a shimmer generator, which is the exact defect this rewrite exists to remove.
// step() on a hashed brightness keeps only ~14% of cells, and the sixth-power
// magnitude curve makes a handful much brighter than the rest -- an even field
// of equal dots reads as sensor noise rather than as sky.
float starField(vec3 rd, float pixAng) {
  vec2 sc = vec2(atan(rd.z, rd.x) * 0.15915494,
                 asin(clamp(rd.y, -1.0, 1.0)) * 0.31830989) * 190.0;
  vec2 cell = floor(sc);
  vec2 f = fract(sc) - rand2(cell);
  float lit = step(0.86, rand(cell + 11.7));
  float mag = pow(rand(cell + 3.1), 6.0);
  float rad = max(0.05, pixAng * 45.0);
  // Fade out towards the horizon, where haze would swallow them anyway; this
  // also hides the pole distortion of the asin() lattice.
  float band = smoothstep(0.02, 0.35, rd.y);
  return lit * mag * band * smoothstep(rad, 0.0, length(f)) * 5.0;
}

// Twilight sky: a perceptual gradient plus a low sun.
//
// The gradient endpoints are built in OKLab rather than mixed in sRGB, so the
// traverse from horizon to zenith holds its chroma instead of passing through
// the desaturated middle a linear RGB mix gives. hue rotates the whole thing
// per activation, which is what makes one run cold blue and the next amber.
//
// Returned values are HDR: the sun core peaks around 24, well past the bloom
// threshold, so it blooms as a light source rather than as a bright patch.
vec3 skyColor(vec3 rd, vec3 sunDir, float hue, float pixAng) {
  float h = clamp(rd.y, -1.0, 1.0);
  // Lightnesses are OKLab L, so the linear values they produce are roughly the
  // cube: 0.42 is ~0.07 linear, 0.15 is ~0.003. Deliberately dark. An earlier
  // pass used 0.58/0.40/0.24 and, once ACES and the sRGB encode had had their
  // way with it, the whole frame came out pastel with nothing left to contrast
  // against -- a night landscape has to actually be night.
  vec3 zenith = oklabRamp(hue, 0.19, 0.070, 0.0);
  vec3 mid = oklabRamp(hue + 0.05, 0.31, 0.080, 0.0);
  vec3 horizon = oklabRamp(hue + 0.14, 0.46, 0.100, 0.0);
  // Two-stage blend: horizon -> mid over the first few degrees, mid -> zenith
  // over the rest. A single pow() curve either crushes the horizon band to
  // nothing or spreads it halfway up the sky.
  vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.28, h));
  col = mix(col, zenith, smoothstep(0.10, 0.85, h));
  // Below the horizon the sky is only ever seen through the ground's reflection
  // and in the fog, so it darkens rather than mirroring.
  col *= mix(0.35, 1.0, smoothstep(-0.25, 0.0, h));

  float sd = clamp(dot(rd, sunDir), -1.0, 1.0);
  vec3 sunTint = vec3(1.0, 0.72, 0.42);
  // Disc as an angle test rather than a huge pow() exponent: the radius is then
  // in radians, so it can be widened to at least a pixel and antialiased with
  // the pixel footprint instead of aliasing into a flickering dot.
  float ang = acos(sd);
  float discR = max(0.011, pixAng * 2.0);
  col += sunTint * 12.0 * smoothstep(discR, discR * 0.55, ang);
  // Two glow lobes only, and both far weaker than the first attempt's. A broad
  // pow(sd, 6) wash carried more energy than the entire sky gradient, so
  // whenever the camera swung towards the sun the frame turned to milk.
  col += sunTint * (0.85 * pow(max(sd, 0.0), 220.0) + 0.09 * pow(max(sd, 0.0), 16.0));
  col += starField(rd, pixAng);
  return col;
}

// Surface colour from the orbit trap.
//
// trap.w (minimum orbit radius) bands broadly and drives hue; min(trap.x,
// trap.y) bands much more finely and drives lightness, which is what produces
// the fine striping across each lobe. Hue sweeps only 0.34 of a turn -- a full
// wheel across one object reads as a rainbow decal rather than as a material.
vec3 bulbAlbedo(vec4 trap, float hue) {
  float band = clamp(trap.w * 1.55, 0.0, 1.0);
  float fine = clamp(min(trap.x, trap.y) * 3.2, 0.0, 1.0);
  // L capped at 0.76 and C at 0.125. glsl-lib measured L=0.75 / C=0.12 as the
  // point where an OKLab ramp stays inside sRGB for every hue; pushing past it
  // clips a channel to zero, and a clipped channel does not read as "brighter"
  // but as neon -- the green seed came out as poster paint at L=0.81 / C=0.145.
  float L = 0.58 + 0.18 * fine;
  float C = 0.095 + 0.030 * band;
  return oklabRamp(band * 0.34, L, C, hue);
}

// ---------------------------------------------------------------- marching

// Cone-traced primary march.
//
// The hit epsilon widens with distance in proportion to the pixel footprint,
// which is the fix for the acne and banding the old fixed 0.0006 produced at
// grazing angles: a fixed epsilon asks for detail far finer than a pixel can
// show, so the march either runs out of steps or lands on estimator noise.
// Widening it also *prefilters* the surface -- sub-pixel structure merges
// instead of popping in and out as the camera moves, which is half the shimmer
// fix on its own.
//
// Returns true on a hit; t, trap and glow are outputs.
bool marchBulb(vec3 ro, vec3 rd, float power, float pixelRadius,
               float tStart, float tEnd, out float t, out vec4 trap, out float glow) {
  t = tStart;
  trap = vec4(1e10);
  glow = 0.0;
  for (int i = 0; i < PRIMARY_STEPS; i++) {
    vec4 tr;
    float d = bulbDE(ro + rd * t, power, DE_FINE, tr);
    // Hit tolerance, in units of the pixel's own footprint. The coefficient was
    // 0.55; 1.6 is a deliberate loosening for the wall.
    //
    // This is why the saver is disproportionately expensive at 6000x1200 rather
    // than merely 4x expensive: pixelRadius shrinks as resolution rises, so eps
    // shrinks with it and every ray must march CLOSER to the surface before it
    // terminates. Cost grows with pixels AND with steps-per-pixel.
    //
    // Loosening it trades sub-pixel silhouette precision, which the temporal
    // accumulation already averages over and which is invisible at wall viewing
    // distance, for steps that are not taken.
    float eps = max(2.0e-5, 1.6 * t * pixelRadius);
    // Named stepLen, not step, which is a GLSL builtin this file also uses.
    float stepLen = max(d * 0.92, eps * 0.5);
    // Volumetric-ish glow, weighted by the step length so the accumulation is
    // an integral along the ray rather than a count of iterations. The old
    // 1/(1+40d) per *step* meant slow-marching regions near the surface got
    // hundreds of contributions and fast ones got none, which is why it read as
    // a flat halo pinned to the silhouette.
    //
    // Windowed against the bounding sphere. Without the window the integral
    // jumps from a whole chord's worth to exactly zero as a ray crosses the
    // sphere, and since the march only runs inside it, that showed up as a hard
    // bright disc around the fractal -- a halo sticker rather than a glow.
    float shell = smoothstep(BOUND_R, BOUND_R * 0.82, length(ro + rd * t));
    glow += stepLen * exp(-d * 20.0) * shell;
    if (d < eps) { trap = tr; return true; }
    t += stepLen;
    if (t > tEnd) break;
  }
  return false;
}

// One reflection bounce. Deliberately cheap: coarse DE, no shadow, no AO, sky
// ambient only. A blurred, slightly wrong reflection of a fractal is
// indistinguishable from a correct one, and this runs for a large share of the
// ground pixels.
vec3 reflectBulb(vec3 ro, vec3 rd, float power, vec3 sunDir,
                 float skyHue, float bulbHue, float pixAng) {
  vec2 bs = boundingSphere(ro, rd, BOUND_R);
  if (bs.y > bs.x && bs.y > 0.0) {
    float t = max(bs.x, 0.02);
    for (int i = 0; i < REFLECT_STEPS; i++) {
      vec4 tr;
      float d = bulbDE(ro + rd * t, power, DE_COARSE, tr);
      if (d < 0.004) {
        vec3 p = ro + rd * t;
        vec3 n = calcNormal(p, power, 0.004);
        vec3 alb = bulbAlbedo(tr, bulbHue);
        float diff = clamp(dot(n, sunDir), 0.0, 1.0);
        return alb * (vec3(1.0, 0.78, 0.55) * 3.0 * diff
                    + skyColor(n, sunDir, skyHue, pixAng) * 0.35);
      }
      t += max(d * 0.9, 0.004);
      if (t > bs.y) break;
    }
  }
  return skyColor(rd, sunDir, skyHue, pixAng);
}

// ---------------------------------------------------------------- render

vec3 render(vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / res.y;

  // Per-activation hue for the sky. The bulb takes the opposite side of the
  // OKLab hue wheel: with both on the same hue the first version came out as a
  // single mauve wash with no figure/ground separation at all. Half a turn is
  // the complement, which is what gives a warm subject against a cold sky (or
  // the reverse, depending where the seed lands).
  float hue = iSeed.x;
  float bulbHue = hue + 0.5;

  // Mandelbulb exponent sweep. Below ~4 the surface loses its lobed structure
  // and above ~9 the detail outruns any sane march budget; entering at a random
  // phase means the morphology at activation differs.
  float power = 6.0 + 2.0 * sin(iTime * 0.055 + iSeed.y * 6.2831);

  // Cinematic-ish camera. The azimuth is a constant drift plus a slow sinusoid
  // of comparable magnitude, so the orbit alternately dwells on one face and
  // sweeps past several -- a constant rate reads as a turntable and gives the
  // eye nothing to anticipate over a ten-minute slot. Distance and elevation
  // breathe on their own, mutually prime periods, so the framing never repeats.
  float ct = iTime;
  float az = iSeed.z * 6.2831 + ct * 0.043 + 0.60 * sin(ct * 0.021 + iSeed.y * 6.2831);
  // Distance bounds set by framing, not by taste: the bulb's half-height on
  // screen is BOUND_R * FOCAL / dist, so 5.0 fills 0.53 of the frame height and
  // 6.8 fills 0.39. Closer than 5.0 and the lobes leave the top and bottom of a
  // 1200px-tall wall, which is what the previous version did.
  float dist = 5.9 + 0.9 * sin(ct * 0.029 + iSeed.w * 6.2831);
  float elev = 0.05 + 0.5 * sin(ct * 0.017 + iSeed.x * 6.2831);
  vec3 ro = vec3(dist * cos(az), elev, dist * sin(az));
  vec3 target = vec3(0.0, 0.12, 0.0);
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);

  // Lens shift rather than a rotation: slides the bulb off centre while keeping
  // the horizon level. At 5:1 a centred subject leaves two large dead panels
  // either side; drifting it towards a third gives the composition somewhere to
  // breathe, and the drift is slow enough to be felt rather than seen.
  uv.x += 0.75 * sin(ct * 0.013 + iSeed.z * 6.2831);

  vec3 rd = normalize(uv.x * right + uv.y * up + FOCAL * fwd);

  // Angular size of one pixel. Everything scale-dependent below -- hit epsilon,
  // normal epsilon, star radius -- is expressed in terms of it, so the saver
  // resolves exactly the detail the display can show and no more, at any
  // resolution.
  float pixelRadius = 1.0 / (res.y * FOCAL);

  // Sun kept low and slightly behind the subject, so the bulb is rim-lit and
  // the ground picks up a long specular sheet. Azimuth varies per activation;
  // elevation does not, because a high sun flattens the whole image.
  float sa = iSeed.y * 6.2831;
  vec3 sunDir = normalize(vec3(cos(sa), 0.30, sin(sa)));
  // 3.0, not the 5.0 of the first pass. Peak albedo is ~0.5 linear, so 5.0 put
  // every sunlit facet at 2.5, which ACES maps to 0.93 -- the fractal came out
  // as a white blob with dark cracks and none of the orbit-trap colour
  // survived. 3.0 keeps the brightest facets around 1.5, inside the part of the
  // curve that still has slope.
  vec3 sunCol = vec3(1.0, 0.80, 0.56) * 3.6;

  // Ground plane, intersected analytically. Sphere-tracing a plane is the
  // textbook worst case -- at grazing incidence the field barely decreases and
  // the march either stalls or bands -- and at 5:1 most of the lower frame is
  // grazing, so the closed form is not an optimisation but a correctness fix.
  float tGround = FAR;
  if (rd.y < -1e-4) {
    float tg = (GROUND_Y - ro.y) / rd.y;
    if (tg > 0.0) tGround = min(tGround, tg);
  }

  vec2 bs = boundingSphere(ro, rd, BOUND_R);
  float tBulb;
  vec4 trap;
  float glow = 0.0;
  bool hitBulb = false;
  float tEnter = max(bs.x, 0.0);
  float tExit = min(bs.y, tGround);
  // tExit <= tEnter means the ground is hit before the bounding sphere is
  // entered -- a ray passing under the bulb -- so there is nothing to march.
  if (bs.y > bs.x && tExit > tEnter) {
    hitBulb = marchBulb(ro, rd, power, pixelRadius, tEnter, tExit, tBulb, trap, glow);
  }

  vec3 col;
  float depth;

  if (hitBulb) {
    depth = tBulb;
    vec3 p = ro + rd * tBulb;
    // Normal epsilon tracks the cone footprint for the same reason the hit
    // epsilon does; the floor keeps it above float precision up close.
    vec3 n = calcNormal(p, power, max(6.0e-5, 1.1 * tBulb * pixelRadius));
    vec3 alb = bulbAlbedo(trap, bulbHue);

    float ao, thick;
    aoAndThickness(p, n, power, ao, thick);

    float ndl = clamp(dot(n, sunDir), 0.0, 1.0);
    // Shadow ray started off the surface by a multiple of the hit epsilon,
    // otherwise the first sample is still inside and everything self-shadows.
    float sh = ndl > 0.0
      ? softShadow(p + n * 0.004, sunDir, 0.01, 4.0, 12.0, power)
      : 0.0;

    vec3 lin = vec3(0.0);
    lin += alb * sunCol * ndl * sh;
    // Sky ambient, sampled along the normal: a one-tap IBL. This is why the
    // environment is not just decoration -- the bulb's shadowed side is now lit
    // by the sky it sits under instead of by a hardcoded 0.2 grey.
    // x3, which is not physical for a one-tap probe and is deliberate. A real
    // hemisphere integral over a sky this dark leaves the shadowed side at
    // around 5% sRGB -- correct, and useless on a wall in a lit room, where the
    // ambient wash alone is 12%. This is the term that keeps the AO and the
    // orbit-trap banding visible on the side the sun is not on.
    lin += alb * skyColor(n, sunDir, hue, pixelRadius) * ao * 3.0;
    // Bounce off the ground, which is dark, so this is a small warm fill on
    // downward-facing surfaces only.
    lin += alb * vec3(0.10, 0.07, 0.06) * clamp(0.5 - 0.5 * n.y, 0.0, 1.0) * ao;

    // Translucency. Thin lobes seen against the sun glow from within, which is
    // the effect that makes high-end Mandelbulb renders look like wax or jade
    // rather than like painted plastic. Gated on the view being roughly
    // opposite the light, since that is the only geometry where it happens.
    float back = pow(clamp(dot(rd, sunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    lin += alb * sunCol * 0.45 * back * (1.0 - thick) * ao;

    float fres = 0.03 + 0.97 * pow(clamp(1.0 - dot(n, -rd), 0.0, 1.0), 5.0);

    // Specular, narrow and shadowed. The peak runs well past 1.0 on purpose:
    // the post chain's bloom threshold is what turns it into a highlight with
    // a halo instead of a white dot.
    vec3 hv = normalize(sunDir - rd);
    // Narrow (64) rather than broad. A fractal presents facets at every
    // orientation, so a wide lobe puts a highlight on a large fraction of them
    // at once and the surface goes white; a tight one picks out edges.
    float spec = pow(clamp(dot(n, hv), 0.0, 1.0), 64.0);
    lin += sunCol * spec * sh * (0.04 + 0.9 * fres) * 2.0;

    // Fresnel-weighted reflection of the environment and of the bulb itself.
    // Capped at 0.35 because a fully mirrored fractal loses its own colour at
    // every grazing pixel, which on a lobed surface is most of it -- the first
    // attempt at 0.55 pulled the whole silhouette towards sky colour and undid
    // the complementary palette.
    vec3 rr = reflect(rd, n);
    vec3 refl = reflectBulb(p + n * 0.01, rr, power, sunDir, hue, bulbHue, pixelRadius);
    lin = mix(lin, refl, fres * 0.35);

    col = lin;
  } else if (tGround < FAR) {
    depth = tGround;
    vec3 p = ro + rd * tGround;

    // Shallow ripples, as a normal perturbation rather than as displacement --
    // the plane stays analytic, which is what keeps it free of grazing-angle
    // acne. Amplitude decays with distance so the far plain is mirror flat:
    // a normal that varies faster than a pixel is exactly the aliasing source
    // this rewrite is trying to remove, and at 5:1 the far plain is most of it.
    float ripple = exp(-tGround * 0.14) * 0.11;
    float e = 0.35;
    vec2 q = p.xz * 0.55 + vec2(0.0, iTime * 0.02);
    vec3 n = normalize(vec3(
      -(snoise(q + vec2(e, 0.0)) - snoise(q - vec2(e, 0.0))) * ripple,
      1.0,
      -(snoise(q + vec2(0.0, e)) - snoise(q - vec2(0.0, e))) * ripple));

    // Near-black, faintly mottled slate. Nearly all of what is visible here is
    // reflection and shadow, which is the point: the plane exists to give the
    // soft shadow somewhere to land and to fill the lower band of a 5:1 frame
    // with something that recedes.
    // Raised from the near-black first attempt: the soft shadow lands here and
    // nowhere else, so if the plane has no diffuse response at all the shadow
    // is invisible and the whole point of casting it is lost.
    // Gradient noise, not a hashed grid cell. The first attempt used
    // rand(floor(p.xz)), whose axis-aligned tiles were plainly visible as a
    // checkerboard across the mid-distance -- the exact lattice artifact
    // glsl-lib's simplex noise exists to avoid.
    vec3 alb = vec3(0.055, 0.052, 0.062)
             * (1.0 + 0.35 * snoise(p.xz * 0.22));

    float sh = softShadow(p + n * 0.01, sunDir, 0.02, 12.0, 9.0, power);
    float ndl = clamp(dot(n, sunDir), 0.0, 1.0);

    vec3 lin = alb * sunCol * ndl * sh;
    lin += alb * skyColor(n, sunDir, hue, pixelRadius) * 0.6;

    // Schlick against a dielectric floor. At grazing incidence -- the far half
    // of the plane on a 5:1 frame -- this approaches 1, so the distance turns
    // into a mirror of the sky and the horizon reads as a wet plain rather than
    // as a line.
    float fres = 0.03 + 0.97 * pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 5.0);
    vec3 rr = reflect(rd, n);
    // Reflections fade with distance, standing in for the roughness this
    // perfectly smooth plane does not have; without it the far field mirrors
    // the bulb as sharply as the near field, which looks like glass.
    float sharp = exp(-tGround * 0.06);
    vec3 refl = reflectBulb(p + n * 0.02, rr, power, sunDir, hue, bulbHue, pixelRadius);
    refl = mix(skyColor(rr, sunDir, hue, pixelRadius), refl, sharp);
    // 0.72 rather than a physical 1.0. A perfect mirror of a sky that is the
    // same colour just above and just below the horizon erases the horizon
    // entirely; holding some of the plane's own dark albedo keeps the tonal
    // break that tells the eye there is ground there at all.
    lin = mix(lin, refl * 0.72, fres * 0.72);

    col = lin;
  } else {
    depth = FAR;
    col = skyColor(rd, sunDir, hue, pixelRadius);
  }

  // Aerial perspective. Fog colour is taken from the sky in the view direction,
  // so distance desaturates towards whatever the sky is doing there instead of
  // towards a grey that belongs to no palette.
  if (depth < FAR) {
    // 0.022 puts the subject (5-7 units out) at only 12-14% fog while the far
    // plain, which runs to tens of units, dissolves completely. The first
    // attempt used 0.055 and buried the fractal in haze at its own distance.
    float fog = 1.0 - exp(-depth * 0.022);
    vec3 fogCol = skyColor(rd, sunDir, hue, 0.0) * 0.55;
    col = mix(col, fogCol, fog);
  }

  // Volumetric glow around the fractal. An order of magnitude weaker than the
  // old version, which piled a flat halo over everything; with a real bloom
  // pass downstream this only has to seed the effect, not be it.
  // Kept on the bulb's own hue, not offset: an offset hue reads as a coloured
  // outline drawn around the object rather than as light coming off it. 0.16 is
  // the level at which it still seeds the bloom without becoming a rim.
  col += oklabRamp(bulbHue, 0.78, 0.09, 0.0) * glow * 0.08;

  // The post chain owns tonemapping and the sRGB encode. Doing either here as
  // well double-applies them -- that was issue #140, which lifted blacks by
  // over 100% and washed the fractal out. Emitting linear HDR is also what
  // makes the bloom threshold mean something.
  return max(col, 0.0);
}

void main() {
  // Two spatial samples on a rotated-grid diagonal, offset by this frame's
  // jitter. The pair fixes the worst of the within-frame aliasing on a still
  // display; the jitter is what makes consecutive frames disagree in a
  // controlled, averagable way rather than crawling.
  vec2 j = uJitter;
  vec3 c = render(gl_FragCoord.xy + j + vec2(-0.25, -0.25));
  c += render(gl_FragCoord.xy + j + vec2(0.25, 0.25));
  outColor = vec4(c * 0.5, 1.0);
}
`

// History half-life for the temporal accumulation, in seconds.
//
// Sets the trade directly: longer converges to a cleaner image and smears a
// moving silhouette further. 0.055s is ~3.3 frames at 60Hz, which combined with
// the 2 spatial samples gives ~6-7 effective samples per pixel. At the camera's
// peak angular rate that is under 2px of trailing on a 1200px-tall wall -- read
// as a faint motion blur at 8m, and cheaper than the 4x supersampling it
// replaces.
const TAA_HALF_LIFE_S = 0.055

// Plastic number, for the R2 low-discrepancy sequence used to place the
// per-frame sub-pixel jitter (Roberts 2018). Additive recurrences with this
// constant have the lowest discrepancy of any 2D sequence of this form, so
// every prefix covers the pixel evenly -- unlike a random offset, which clumps,
// or a repeating 4-tap pattern, which reintroduces a fixed aliasing structure.
const R2_A1 = 0.7548776662466927
const R2_A2 = 0.5698402909980532

// Bloom threshold, against this saver's LINEAR output. The scene is deliberately
// dark -- a night plain under a low sun -- so the only things above this are the
// sun lobes (peak ~24), the specular highlights (~3-10) and the brightest sunlit
// lobes. That is exactly what should glow; a lower threshold catches the sky
// gradient and turns the whole frame into haze.
const BLOOM = { threshold: 1.3, knee: 0.5, intensity: 0.38, radius: 1.0 }

export default {
  name: 'Raymarch Fractal',
  create(canvas, seed) {
    // Built in create(), not start(), so the activation's look survives a
    // start/stop cycle.
    const rng = createRng(seed)
    const seedVec = [rng.next(), rng.next(), rng.next(), rng.next()]

    let runtime = null
    let prog = null
    let post = null
    // Frames since the accumulation buffer was last cleared. Drives the
    // progressive 1/(n+1) weighting that makes the first frame a plain render
    // instead of a blend against uninitialised memory.
    let accum = 0
    let lastW = 0
    let lastH = 0
    // Previous frame's timestamp, tracked here rather than read from
    // runtime.dt. The runtime clamps dt to 50ms so a stall cannot advance a
    // *simulation* too far, which is right for simulations and wrong for this:
    // a display filter needs to know how stale its history actually is. With
    // the clamp in place a 1.1s software-rasteriser frame still blended at 47%
    // and the sun smeared into a row of discs.
    let prevTime = 0

    return {
      start() {
        runtime = createGLRuntime(canvas)
        const gl = runtime.gl
        prog = runtime.createQuadProgram(SHADER)
        prog.setSeed(seedVec)
        // Looked up once: a uniform location is fixed for the program's
        // lifetime, and getUniformLocation is a string-keyed driver query.
        const uJitter = gl.getUniformLocation(prog.program, 'uJitter')

        post = createPostChain(gl, canvas, {
          bloom: BLOOM,
          tonemap: 'aces',
          // A touch more exposure in a lit room. The scene is a night
          // landscape, so it has the least headroom against an ambient wash of
          // anything in the set.
          exposure: isBigRoomDisplay(canvas) ? 1.3 : 1.0,
          dither: true,
        })

        runtime.start((time, frame) => {
          // A resize reallocates the scene target and discards its contents, so
          // the accumulation has to restart rather than blend against garbage.
          if (canvas.width !== lastW || canvas.height !== lastH) {
            lastW = canvas.width
            lastH = canvas.height
            accum = 0
          }
          if (post) post.resize()

          const target = post ? post.sceneTarget.fbo : null
          gl.bindFramebuffer(gl.FRAMEBUFFER, target)
          gl.viewport(0, 0, canvas.width, canvas.height)

          if (accum === 0) {
            // Half-float targets come back undefined, and 0 * NaN is NaN, so
            // the first frame has to clear rather than rely on a weight of 1.
            gl.clearColor(0, 0, 0, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)
          }

          // Weight of the new sample. The wall-clock term is the steady state;
          // the 1/(n+1) term dominates for the first few frames so the image is
          // a true running average while the history is still short.
          //
          // Without a post chain there is no persistent buffer to accumulate
          // into, so the weight is forced to 1 and the saver degrades to the
          // plain 2x supersampled render.
          const dt = accum === 0 ? 0 : Math.max(0, time - prevTime)
          prevTime = time
          const alpha = post
            ? Math.max(fadeAlphaForHalfLife(dt, TAA_HALF_LIFE_S), 1 / (accum + 1))
            : 1

          if (alpha < 1) {
            gl.enable(gl.BLEND)
            gl.blendColor(0, 0, 0, alpha)
            gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA)
          } else {
            gl.disable(gl.BLEND)
          }

          // R2 sequence, recentred on the pixel and halved: the shader's two
          // fixed samples already sit at +/-0.25, so a +/-0.25 jitter keeps the
          // combined filter support to exactly one pixel. A full-width jitter
          // would reach 0.75px and soften the image for no extra coverage.
          const jx = (((0.5 + R2_A1 * accum) % 1) - 0.5) * 0.5
          const jy = (((0.5 + R2_A2 * accum) % 1) - 0.5) * 0.5

          prog.draw(time, frame, (g) => g.uniform2f(uJitter, jx, jy))
          gl.disable(gl.BLEND)
          accum++

          if (post) post.present()
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (prog) { prog.destroy(); prog = null }
        if (runtime) { runtime.destroy(); runtime = null }
        accum = 0
        lastW = 0
        lastH = 0
        prevTime = 0
      }
    }
  }
}
