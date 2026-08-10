// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Aquarium -- schooling fish in a wide tank (issue #66).
 *
 * A boids problem with art direction. The flocking maths is boids.js', but
 * three things about it had to change before fish would read as fish:
 *
 *  1. NO WRAPPING. boids.js lives on a torus, so a bird crossing the right edge
 *     reappears on the left. A *fish* that does that stops being a fish
 *     instantly -- the tank has glass. Here the walls are soft steering forces
 *     that ramp through a margin band, and the fish bank away from them; the
 *     hard clamp at the very edge exists only so a pathological frame delta
 *     cannot put one outside, and in normal running it is never reached.
 *
 *  2. EXACT NEIGHBOURS, NOT SAMPLED ONES. boids.js draws 32 random neighbours
 *     out of 4,096 each frame, so the forces flicker frame to frame (#127). For
 *     abstract dots that reads as energy; for fish it reads as broken. This
 *     shoal is deliberately small -- a few hundred fish, because a fish is 40x
 *     the screen area of a boid, so a few hundred already fills a tank -- and at
 *     that size every fish can simply test *every* other fish. 676^2 = 457k
 *     interactions a frame is less work than the bird flock does, and there is
 *     no sampling noise left to filter.
 *
 *  3. STEERING, NOT FORCE INTEGRATION. Velocity is a unit heading times a
 *     cruise speed, and the heading is a rate-limited low-pass of the desired
 *     heading. That is what a fish physically does (a fish has a turn radius),
 *     and it is also what stops any force spike from throwing one across the
 *     tank. The simulation cannot explode: speed is assigned, never accumulated.
 *
 * The scene is what makes it an aquarium rather than a particle sim, and it is
 * built in five depth-ordered layers, all rendered into one HDR target:
 *
 *   background pass  water column, surface shimmer, god rays, caustic-lit sand,
 *                    kelp silhouettes
 *   the shoal        instanced oriented quads, SDF fish, sorted far-to-near
 *   large fish       a few slow independents on wandering paths, which the
 *                    shoal scatters away from
 *   foreground pass  rising bubbles, marine snow, out-of-focus near kelp
 *   post chain       bloom on the genuinely bright things, ACES, dither
 *
 * The light is the whole trick. One family of functions -- causticWeb() and
 * shaftField() -- lights the surface, the god rays, the sand AND the fish, so a
 * fish visibly brightens as it swims through a shaft and dims again when it
 * leaves. That single shared sample is what sells "underwater"; without it the
 * fish look pasted onto a blue background.
 *
 * Ambient light is handled by having a real lightness range (OKLab L runs 0.12
 * at the tank floor to 0.74 just under the surface) plus a modest exposure lift
 * on wall-sized canvases -- not by lifting black to a flat tint, which is what
 * makes several of the older savers read as mud.
 *
 * Per-activation variation: shoal count and temperament, kelp layout, god-ray
 * placement and lean, water hue, the wandering paths of both the shoals and the
 * large fish, and how many fish carry the warm accent colour.
 */
import {
  createGLRuntime, createFullscreenPass, createPingPong, createFloatTarget,
  buildProgram, pointScale, particleSide, luminanceScale
} from './gl-base.js'
import { GLSL, createInstancedQuads, createUniformCache, canvasAspect } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// Shoal size. Far smaller than the particle savers' because a fish covers
// roughly 900px^2 against a particle's 20: 400 fish already put ~9% of a 1080p
// frame under fish, and much past that the tank reads as soup rather than as a
// school with water around it.
const SIDE = 20            // 20x20 = 400 fish at 1080p
// The cost here is O(COUNT^2) (see the header), so the cap is tight. It is also
// nearly the right answer visually: pointScale grows each fish's area by the
// same factor the canvas grows, so a *constant* count already holds density
// constant on the wall. 26^2 = 676 is a deliberate ~1.7x, giving the 5:1 tank a
// slightly bigger school to fill its extra width with.
const MAX_SIDE = 26

// Shoals. Alignment and cohesion apply only within a shoal, so the tank holds
// two or three distinct groups with open water between them. One shoal on a
// 6000px wall is a dot; a uniform spread of 676 fish is a texture. Separate
// groups on separate wandering paths is what gives the eye somewhere to land.
const SCHOOLS = 3

// Large independent fish. Fixed-size uniform arrays rather than a state
// texture: at this count the arrays are smaller than the texture upload would
// be, and the shoal's sim shader needs to read them too (for the startle).
const BIG_FISH = 6

// Kelp blades in the background, and in the near-foreground.
const KELP = 10
const FG_KELP = 2

// Perpendicular extent of a fish quad as a fraction of its length. Sized from
// the shape itself: the widest point of a large fish's forked tail sits at
// 0.26 fish-lengths from the centre line and the tail swing adds up to 0.10 on
// top of that, so anything under ~0.72 clips the tail at the extremes of its
// beat -- a subtle defect that reads as the fin flickering.
const QUAD_PERP = 0.72

// =============================================================================
// Shared GLSL. These are spliced into several programs, so anything here has to
// be identical everywhere -- which is the point: the fish are lit by literally
// the same shaft and caustic functions that draw the water.
// =============================================================================

/**
 * Water colour down the column, interpolated in OKLab.
 *
 * Three anchors, not two. A straight lerp from bright surface to dark floor
 * passes through a desaturated grey-blue middle, and the middle is exactly
 * where the fish are -- so the tank would be muddiest precisely where it needs
 * to be most readable. The mid anchor holds chroma up through that band.
 */
const WATER_GLSL = /* glsl */`
vec3 waterColor(float depth01) {
  vec3 top = vec3(0.720, -0.062, -0.004);   // just under the surface, bright teal
  vec3 mid = vec3(0.405, -0.066, -0.078);   // open water, where the shoal swims
  vec3 low = vec3(0.100, -0.022, -0.066);   // the floor, deep and nearly black
  vec3 lab = mix(top, mid, smoothstep(0.0, 0.62, depth01));
  lab = mix(lab, low, smoothstep(0.56, 1.0, depth01));
  return max(oklabToLinear(lab), 0.0);
}

// Depth parameter from a world-space point: 0 at the surface, 1 at the floor.
float waterDepth(vec2 w) { return clamp(0.5 - w.y, 0.0, 1.0); }
`

/**
 * Caustics as the bright borders of a drifting Voronoi tessellation.
 *
 * Ridged fbm is the cheap answer and it is wrong: it gives wandering bright
 * *lines*, where a real caustic is the focal curve of a wavy surface and forms
 * a closed polygonal net that continuously splits and merges. F2-F1 Worley is
 * that net exactly, and it costs nine cells -- comparable to two octaves of
 * simplex, which is what the wrong answer costs.
 *
 * The input is warped by simplex first so the cells breathe and shear instead
 * of sliding rigidly, and the feature points orbit so the net reorganises.
 *
 * Requires: GLSL.hash (rand2), GLSL.simplex2d (snoise).
 */
const CAUSTIC_GLSL = /* glsl */`
float causticWeb(vec2 p, float t) {
  p += 0.30 * vec2(snoise(p * 0.70 + vec2(0.0, t * 0.11)),
                   snoise(p * 0.70 + vec2(t * 0.09, 5.3)));
  vec2 g = floor(p);
  vec2 f = p - g;
  float f1 = 8.0;
  float f2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 r = rand2(g + o);
      // 0.42 keeps every point inside its own cell, which is what makes the
      // 3x3 neighbourhood sufficient -- a larger orbit would let the true
      // nearest point fall outside the search and the net would tear.
      vec2 d = o + 0.5 + 0.42 * sin(t * 0.55 + 6.28318530718 * r) - f;
      float q = dot(d, d);
      if (q < f1) { f2 = f1; f1 = q; } else if (q < f2) { f2 = q; }
    }
  }
  // F2-F1 is zero exactly on a cell border and grows away from it, so the
  // complement raised to a power is a thin bright web rather than a blur.
  float edge = sqrt(f2) - sqrt(f1);
  return pow(1.0 - clamp(edge * 1.30, 0.0, 1.0), 3.2);
}
`

/**
 * God rays: four slabs of light from the surface.
 *
 * Sheared rather than rotated. A rotated beam leaves the top of the frame at an
 * angle and the eye reads it as a diagonal stripe; shearing keeps the beam
 * rooted at the surface across the whole width while still converging
 * downward, which is what actually happens when sun enters water.
 *
 * Sampled by the *fish* shader as well as the background, so a fish crossing a
 * shaft lights up. That is the single most convincing detail in the scene and
 * it costs one function call.
 *
 * Requires: GLSL.simplex2d (snoise).
 */
const SHAFT_GLSL = /* glsl */`
uniform vec4 uShaftX;     // beam centres in the sheared coordinate
uniform vec4 uShaftW;     // beam half-widths at the surface
uniform vec4 uShaftI;     // beam intensities
uniform vec4 uShaftP;     // drift phases
uniform float uShaftLean; // shear: how far a beam leans per unit of depth

float shaftField(vec2 w, float t) {
  float d = waterDepth(w);
  float s = w.x + w.y * uShaftLean;
  float acc = 0.0;
  for (int i = 0; i < 4; i++) {
    // Beams drift slowly sideways, so the composition never settles.
    float cx = uShaftX[i] + 0.11 * sin(t * (0.031 + 0.011 * float(i)) + uShaftP[i]);
    // ... and spread with depth, because the water scatters them.
    float wd = uShaftW[i] * (1.0 + 1.9 * d);
    float k = (s - cx) / wd;
    acc += exp(-k * k) * uShaftI[i];
  }
  // Extinction with depth. 2.4 puts roughly 9% of the surface brightness on the
  // sand, which is enough for the shafts to visibly reach the floor without
  // flattening the vertical gradient the water colour depends on.
  acc *= exp(-d * 2.4);
  // Dappled by a slow noise so a beam breathes rather than sitting there.
  acc *= 0.62 + 0.55 * snoise(vec2(s * 2.6, d * 1.4 - t * 0.20));
  return max(acc, 0.0);
}
`

/**
 * Kelp blade coverage.
 *
 * A blade is a vertical curve with a taper, not a polygon: the pixel's distance
 * to the swaying centre line is compared against a half-width that is widest a
 * third of the way up and comes to a point at the tip. The sway is quadratic in
 * height so the base stays planted -- a blade that sways at the root looks like
 * a wiper, not a plant.
 *
 * a = (rootX, height, halfWidth, phase), b = (swayAmp, lean, tone, swaySpeed)
 */
const KELP_GLSL = /* glsl */`
float kelpBlade(vec2 w, float floorY, vec4 a, vec4 b, float t, float soft) {
  float h = w.y - floorY;
  if (h < 0.0 || h > a.y) return 0.0;
  float u = h / a.y;
  // Static lean plus a travelling sway. The phase term running down the blade
  // is what makes it ripple instead of pivoting as a rigid stick.
  float cx = a.x + (b.y + b.x * sin(t * b.w + a.w - 2.2 * u)) * u * u;
  float dx = abs(w.x - cx);
  // Widest at u ~ 0.35, tapering to nothing at the tip.
  float hw = a.z * pow(max(0.0, 1.0 - u), 0.55) * (0.45 + 0.85 * sin(3.14159265 * pow(u, 0.55)));
  return 1.0 - smoothstep(-soft, soft, dx - hw);
}
`

// =============================================================================
// Background pass: everything behind the fish.
// =============================================================================

const BG_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform vec3 uRes;
uniform float uTime;
uniform float uAspect;
uniform vec4 uKelpA[${KELP}];
uniform vec4 uKelpB[${KELP}];
uniform vec4 uTuning;     // x = floor height, y = sand hue turns, z = caustic gain, w = surface gain
out vec4 outColor;

${GLSL.hash}
${GLSL.simplex2d}
${GLSL.palette}
${WATER_GLSL}
${CAUSTIC_GLSL}
${SHAFT_GLSL}
${KELP_GLSL}

void main() {
  vec2 w = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;   // world space, y in [-0.5, 0.5]
  float d = waterDepth(w);
  float px = 1.0 / uRes.y;

  vec3 col = waterColor(d);

  // --- the surface, seen from below -------------------------------------
  // Compressed vertically as it approaches y = 0.5, which is the cheapest
  // honest perspective cue in the whole scene: it turns a band of noise into a
  // ceiling you are looking up at.
  float surf = smoothstep(0.24, 0.48, w.y);
  if (surf > 0.001) {
    // Two scales of ripple, both compressed vertically as they approach y=0.5.
    // The compression is the cheapest honest perspective cue in the scene: it
    // is what turns a band of noise into a ceiling you are looking up at.
    float persp = 0.075 / max(0.5 - w.y, 0.010);
    float rip = causticWeb(vec2(w.x * 3.3, persp * 2.1 + uTime * 0.05), uTime * 0.9);
    float fine = causticWeb(vec2(w.x * 7.2 + 11.0, persp * 3.8 - uTime * 0.04), uTime * 0.6);
    float m = surf * surf;
    // Deliberately HDR. The surface is the only genuinely bright thing in the
    // tank and it is what the bloom threshold is set against; clamping it here
    // would flatten the whole scene (issue #140's failure mode). Note it is
    // ADDED, not mixed toward a pale colour -- mixing is what made the top of
    // the frame a flat milky bar with the chroma washed out of it.
    col += vec3(0.26, 0.58, 0.68) * (rip * 0.80 + fine * 0.45) * m * uTuning.w;
    // Kept under the bloom threshold on average and over it only on the ripple
    // crests. That distinction is the whole reason the top of the frame is not
    // a milky bar: the surface band covers ~15% of a 5:1 canvas, and a bloom
    // pyramid six levels deep turns a large bright region into a global veil
    // rather than a glow. Small bright things bloom; big bright things fog.
    // The last few centimetres, where the underside of the surface acts as a
    // mirror. Thin and very bright, so it bounds the composition at the top.
    // A wavy boundary, not a ruled line. A dead-straight bright edge across
    // 6000px is the single most artificial thing the frame can contain.
    float wave = 0.013 * sin(w.x * 6.5 + uTime * 0.33)
               + 0.009 * snoise(vec2(w.x * 2.7, uTime * 0.14));
    float skin = smoothstep(0.428 + wave, 0.499 + wave, w.y);
    col += vec3(0.34, 0.52, 0.60) * skin * (0.10 + 1.05 * rip) * uTuning.w;
  }

  // --- god rays ----------------------------------------------------------
  float ray = shaftField(w, uTime);
  col += vec3(0.40, 0.78, 0.92) * ray * 0.60;

  // --- sand floor --------------------------------------------------------
  // A gently undulating line rather than a straight one; two octaves is enough
  // at this scale and a straight edge across 6000px would read as a shelf.
  float floorY = -0.5 + uTuning.x + 0.020 * snoise(vec2(w.x * 0.75, 3.1))
                                  + 0.008 * snoise(vec2(w.x * 2.30, 8.7));
  float onSand = 1.0 - smoothstep(-px * 1.5, px * 1.5, w.y - floorY);
  if (onSand > 0.001) {
    // Caustics on the sand: the same web as the surface, seen at a grazing
    // angle, hence the strong vertical squash. Scaled so the sand band is a
    // couple of cells tall and dozens wide -- at the first attempt it was less
    // than ONE cell tall, so the whole floor sat inside a single Voronoi
    // interior at a time and the caustics blinked in and out over tens of
    // seconds instead of shifting continuously.
    float caus = causticWeb(vec2(w.x * 5.5, (w.y - floorY) * 26.0 + 3.0), uTime * 0.9);
    vec3 sand = oklabRamp(0.0, 0.50, 0.075, uTuning.y);
    // Grain, so the floor is not a flat wash under the caustics.
    sand *= 0.86 + 0.28 * snoise(w * vec2(38.0, 120.0));
    // The sand is at the bottom of the column, so it is seen through the whole
    // depth of water: mostly water colour, with the caustics punching through.
    vec3 lit = mix(waterColor(0.97), sand, 0.34);
    // Warmer than the light in the water column: this is light that has
    // bounced off sand, and keeping it the same cyan as the shafts is what
    // makes a rendered sea floor look like painted concrete.
    lit += vec3(0.52, 0.66, 0.58) * caus * uTuning.z * (0.35 + 1.4 * ray);
    col = mix(col, lit, onSand);
  }

  // --- kelp --------------------------------------------------------------
  // Silhouettes, not black shapes: at this depth a kelp blade is still seen
  // through metres of water, so it darkens the column rather than replacing it.
  for (int i = 0; i < ${KELP}; i++) {
    vec4 a = uKelpA[i];
    // Cheap rejects first. Kelp is spatially coherent, so almost every pixel
    // fails both of these for almost every blade.
    if (w.y > floorY + a.y) continue;
    if (abs(w.x - a.x) > a.z + abs(uKelpB[i].x) + abs(uKelpB[i].y) + 0.05) continue;
    float m = kelpBlade(w, floorY, a, uKelpB[i], uTime, px * 1.6);
    if (m <= 0.0) continue;
    vec3 kelpCol = oklabRamp(0.0, 0.20 * uKelpB[i].z, 0.075, 0.38);
    // Rim: the blade edge catches the shaft light, which is what stops the
    // kelp reading as a hole cut in the picture.
    col = mix(col, kelpCol + vec3(0.10, 0.20, 0.18) * ray, m * 0.88);
  }

  // --- framing -----------------------------------------------------------
  // A very soft darkening at the extreme left and right only. A conventional
  // radial vignette on a 5:1 canvas darkens most of the picture; this just
  // closes the ends of the tank so the eye stays inside it.
  float edge = abs(w.x) / max(0.5 * uAspect, 0.001);
  col *= 1.0 - 0.30 * smoothstep(0.72, 1.0, edge);

  outColor = vec4(max(col, 0.0), 1.0);
}`

// =============================================================================
// Shoal simulation.
// =============================================================================

/**
 * Build the simulation shader for a given flock size.
 *
 * COUNT is spliced in as a literal because the neighbour loop is exhaustive and
 * GLSL ES 3.00 requires a constant loop bound. That also lets the driver unroll
 * or vectorise it, which a uniform bound would prevent.
 */
function simFragment(side) {
  const count = side * side
  return /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uState;   // xy = position (world), zw = velocity (world/s)
uniform sampler2D uAttr;    // x = depth, y = size, z = shoal + tint, w = phase
uniform vec2 uTexel;
uniform float uDt;
uniform float uTime;
uniform float uAspect;
uniform vec3 uRadii;        // separation, alignment, cohesion
uniform vec3 uWeights;      // separation, alignment, cohesion
uniform vec2 uHome[${SCHOOLS}];
uniform vec2 uPull;         // x = shoal-target pull, y = wander
uniform vec2 uSpeed;        // x = cruise speed, y = unused headroom
uniform float uTurn;        // base turn rate, 1/s
uniform vec4 uBounds;       // minX, maxX, minY, maxY of the free-swimming box
uniform vec2 uMargin;       // width of the turn-around band, x and y
uniform vec4 uBig[${BIG_FISH}];  // xy = position, zw = velocity of the large fish
uniform float uStartle;     // radius of the scatter response
out vec4 outState;

${GLSL.worldSpace}

const int COUNT = ${count};
const int SIDE = ${side};

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  vec4 a = texture(uAttr, uv);
  vec2 pos = s.xy;
  vec2 vel = s.zw;
  float shoal = floor(a.z);

  vec2 sep = vec2(0.0);
  vec2 ali = vec2(0.0);
  vec2 coh = vec2(0.0);
  float an = 0.0;
  float cn = 0.0;

  // Exhaustive neighbour search. See the module header: at a few hundred fish
  // this is affordable and it is the only way to get a school that does not
  // shimmer, because sampled forces change discontinuously every frame and a
  // shimmering school is immediately legible as wrong in a way a shimmering
  // cloud of dots is not.
  for (int i = 0; i < COUNT; i++) {
    vec2 ouv = (vec2(float(i - (i / SIDE) * SIDE), float(i / SIDE)) + 0.5) / float(SIDE);
    vec4 o = texture(uState, ouv);
    vec2 d = o.xy - pos;
    float dist = length(d);
    if (dist < 1e-5) continue;
    // Separation is between every fish regardless of shoal -- nothing swims
    // through anything -- while alignment and cohesion are shoal-local, which
    // is what keeps the groups distinct instead of merging into one cloud.
    if (dist < uRadii.x) sep -= d / dist * (uRadii.x - dist);
    if (dist > uRadii.z || floor(texture(uAttr, ouv).z) != shoal) continue;
    // Cohesion reaches much further than alignment, and that asymmetry is the
    // whole reason the shoals survive ten minutes. With one radius for both, a
    // shoal that gets stretched -- by a startle, or by its target turning --
    // falls below the density where anyone has neighbours, and it never
    // re-forms: by minute one the tank is a uniform wallpaper of fish. A long
    // cohesion radius is free here because the neighbour search is exhaustive
    // anyway, and it is what pulls a stretched shoal back into a shoal.
    coh += d;
    cn += 1.0;
    if (dist < uRadii.y) { ali += o.zw; an += 1.0; }
  }

  vec2 steer = sep * uWeights.x;
  if (an > 0.0) steer += (ali / an - vel) * uWeights.y;
  if (cn > 0.0) steer += (coh / cn) * uWeights.z;

  // The shoal's slowly wandering destination. This is what makes a school sweep
  // the length of a 6000px tank over a couple of minutes rather than milling
  // about the middle -- by far the most important single term at 5:1. Saturated
  // at unit distance so a far-away target pulls no harder than a near one, and
  // therefore never beats the local flocking.
  int si = int(shoal);
  vec2 toHome = uHome[si] - pos;
  steer += toHome / max(length(toHome), 1.0) * uPull.x;

  // Per-fish wander, so a settled shoal still breathes.
  float wob = uTime * 0.55 + a.w * 9.0;
  steer += vec2(sin(wob * 1.7), cos(wob * 1.31)) * uPull.y;

  // Soft walls. The tank has glass: a fish may not wrap and may not teleport,
  // so instead of a torus the boundary is a band the fish steers out of, with
  // the force ramping quadratically across it.
  vec2 over = vec2(max(0.0, pos.x - uBounds.y) - max(0.0, uBounds.x - pos.x),
                   max(0.0, pos.y - uBounds.w) - max(0.0, uBounds.z - pos.y));
  vec2 tb = clamp(abs(over) / uMargin, 0.0, 1.0);
  steer -= sign(over) * tb * tb * 9.0;
  float urgency = max(tb.x, tb.y);

  // Startle. A large fish pushes the shoal apart as it passes and the shoal
  // re-forms behind it -- the behaviour that makes people watch rather than
  // glance. Same mechanic as a predator, driven by the large fish that are
  // already in the scene.
  float alarm = 0.0;
  for (int i = 0; i < ${BIG_FISH}; i++) {
    vec2 d = pos - uBig[i].xy;
    float l = length(d);
    if (l < uStartle) {
      float f = 1.0 - l / uStartle;
      steer += d / max(l, 1e-4) * f * f * 10.0;
      alarm = max(alarm, f);
    }
  }

  // Steering, not force integration (see the module header). The heading is a
  // rate-limited low-pass of the desired heading, and the speed is assigned
  // rather than accumulated, so no force spike can ever throw a fish.
  float sp0 = length(vel);
  vec2 prev = sp0 > 1e-5 ? vel / sp0 : vec2(1.0, 0.0);
  // NOTE the absence of a dt here, which is not an oversight. The steer
  // vector is a desired *heading offset*, not an acceleration: adding it to the
  // heading and renormalising gives the direction the fish wants to face, and
  // the rate limiter below is the only thing that consumes dt. Scaling steer by
  // dt as well attenuates the turn twice, which cost three tuning rounds here:
  // the effective turn rate came out around 3 degrees per second, the shoals
  // could not follow their targets at all, and by minute three the tank was a
  // uniform drift of fish. Frame-rate independence comes from the exponential
  // below, and this line must stay outside it.
  vec2 want = prev + steer;
  float wl = length(want);
  vec2 wantDir = wl > 1e-5 ? want / wl : prev;
  // Turn rate rises sharply while banking away from glass or bolting from a
  // large fish. Without that boost the cruise turn radius is wider than the
  // 0.16-unit vertical margin and fish grind along the top of the tank.
  float rate = uTurn * (1.0 + 5.0 * urgency + 5.0 * alarm);
  vec2 dir = mix(prev, wantDir, clamp(1.0 - exp(-rate * uDt), 0.0, 1.0));
  float dl = length(dir);
  dir = dl > 1e-5 ? dir / dl : prev;

  // Nearer fish swim slightly faster, which reads as parallax.
  float cruise = uSpeed.x * mix(0.74, 1.16, a.x) * a.y * (1.0 + 1.6 * alarm);
  float sp = mix(sp0, cruise, clamp(1.0 - exp(-2.2 * uDt), 0.0, 1.0));
  vel = dir * sp;
  pos += vel * uDt;

  // Last-resort clamp -- clamp, never wrap. The margin force makes this
  // unreachable in normal running; it is here so that a stalled frame or a
  // startle burst cannot leave a fish outside the glass.
  vec2 ext = worldExtent(uAspect) - vec2(0.012);
  pos = clamp(pos, -ext, ext);

  outState = vec4(pos, vel);
}`
}

// =============================================================================
// Fish rendering. One fragment shader, two vertex shaders: the shoal fetches
// its instance from the simulation texture, the large fish from uniform arrays.
// =============================================================================

// Varyings both vertex shaders must produce, in the same order and types.
const FISH_VARYINGS = /* glsl */`
out vec2 vQuad;    // unit-quad corner, [-0.5, 0.5]
out vec2 vWorld;   // world position, for sampling the light
out float vUp;     // +1/-1: maps local +y to world up (see below)
out float vDepth;  // 0 far, 1 near
out float vTint;   // species/colour selector, [0,1)
out float vBeat;   // tail-beat phase, radians
out float vSway;   // tail-beat amplitude, in fish lengths
`

/**
 * Shared tail of both fish vertex shaders.
 *
 * `vUp` is the fix for the orientation trap. orientedQuadOffset builds its
 * perpendicular axis as (-dir.y, dir.x), whose y component has the sign of
 * dir.x -- so for a fish swimming left, local +y points at the world floor and
 * an asymmetric fish (dorsal fin up, deep belly down, eye above the midline)
 * renders upside down. Passing sign(dir.x) through and multiplying the
 * fragment's local y by it puts world-up back on top at every heading. The only
 * cost is a flip at exactly vertical, where the fish is symmetric on screen
 * anyway.
 */
const FISH_VERT_TAIL = /* glsl */`
void emitFish(vec2 pos, vec2 vel, float depth, float sizePx, float tint, float phase) {
  float sp = length(vel);
  vec2 dir = sp > 1e-5 ? vel / sp : vec2(1.0, 0.0);

  vQuad = aCorner;
  vWorld = pos;
  vUp = dir.x >= 0.0 ? 1.0 : -1.0;
  vDepth = depth;
  vTint = tint;
  // Beat frequency rises with speed, as a real fish's does, and the amplitude
  // with it -- a fish holding station barely moves its tail.
  float beatHz = 1.5 + sp * 16.0;
  vBeat = uTime * beatHz * 6.28318530718 + phase;
  vSway = clamp(0.035 + sp * 0.30, 0.0, 0.10);

  // Built in PIXEL space and converted afterwards, which is not what boids.js
  // does: folding uQuadScale into the size before rotating scales the rotated
  // vector's y component by the x conversion factor, so the quad shears on any
  // non-square canvas. Invisible at 16:9 and a 5x shear on the wall.
  vec2 size = vec2(sizePx, sizePx * ${QUAD_PERP.toFixed(2)});
  vec2 offset = orientedQuadOffset(vel, size, 1.0) * uQuadScale;
  gl_Position = clipFromWorld(pos, uAspect) + vec4(offset, 0.0, 0.0);
}
`

const SHOAL_VERT = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uAttr;
uniform float uSizePx;
uniform vec2 uQuadScale;
uniform float uAspect;
uniform float uTime;
${FISH_VARYINGS}
${GLSL.instancedQuad}
${GLSL.worldSpace}
${FISH_VERT_TAIL}

void main() {
  vec2 uv;
  vec4 s = fetchInstance(uv);
  vec4 a = texture(uAttr, uv);
  // Nearer fish are bigger. Combined with the depth haze in the fragment
  // shader this is the whole depth cue, and it costs one mix.
  float sizePx = uSizePx * a.y * mix(0.60, 1.30, a.x);
  emitFish(s.xy, s.zw, a.x, sizePx, fract(a.z), a.w * 6.28318530718);
}`

const BIG_VERT = /* glsl */`#version 300 es
precision highp float;
in vec2 aCorner;
uniform vec4 uBigA[${BIG_FISH}];   // xy = position, zw = velocity
uniform vec4 uBigB[${BIG_FISH}];   // x = depth, y = length px, z = tint, w = phase
uniform int uBase;                 // first index to draw, so far ones can go behind the shoal
uniform vec2 uQuadScale;
uniform float uAspect;
uniform float uTime;
${FISH_VARYINGS}
${GLSL.worldSpace}

// orientedQuadOffset lives in GLSL.instancedQuad alongside the state-texture
// fetch this shader does not use, so it is restated here rather than pulling in
// a uState/uSide pair that would never be bound.
vec2 orientedQuadOffset(vec2 vel, vec2 size, float stretch) {
  float speed = length(vel);
  vec2 dir = speed > 1e-4 ? vel / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 c = aCorner * size;
  return dir * (c.x * stretch) + perp * c.y;
}

${FISH_VERT_TAIL}

void main() {
  int id = gl_InstanceID + uBase;
  vec4 a = uBigA[id];
  vec4 b = uBigB[id];
  emitFish(a.xy, a.zw, b.x, b.y, b.z, b.w);
}`

/**
 * The fish itself, as an SDF in the oriented quad.
 *
 * Asset-free, which matches the rest of the folder and means the silhouette is
 * exact at 46px on a laptop and at 300px on the wall. The shape is assembled
 * from analytic half-height profiles rather than from CSG of primitives,
 * because a fish is naturally described that way: a lens body whose upper and
 * lower half-heights differ, with the fins simply added to those half-heights
 * so they union with the body for free.
 *
 * The undulation is applied by bending the *query* coordinate, so the whole
 * body flexes along a travelling wave instead of the tail hinging rigidly.
 */
const FISH_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec2 vQuad;
in vec2 vWorld;
in float vUp;
in float vDepth;
in float vTint;
in float vBeat;
in float vSway;
uniform float uTime;
uniform float uBig;      // 0 = shoal fish, 1 = large fish (bigger fins, calmer colour)
out vec4 outColor;

${GLSL.simplex2d}
${GLSL.palette}
${WATER_GLSL}
${SHAFT_GLSL}

void main() {
  // Fish-length units: x runs -0.5 (tail tip) to +0.5 (nose), y perpendicular
  // with world-up positive. vUp is what keeps world-up on top at every heading.
  vec2 q = vec2(vQuad.x, vQuad.y * ${QUAD_PERP.toFixed(2)} * vUp);
  // Half a pixel expressed in fish units, for analytic anti-aliasing. Taken
  // from q.y, which is constant across the quad and therefore stable, rather
  // than from the shape field, whose derivative spikes at the fin tips.
  float px = fwidth(q.y) * 0.75 + 1e-5;

  // Travelling wave down the body. Quadratic in distance from the head so the
  // nose is nearly still and the tail swings, and the phase lag (-3.6 u) is
  // what makes it a wave rather than a rigid wag.
  float u = clamp((0.34 - q.x) / 0.84, 0.0, 1.0);
  float y = q.y - vSway * u * u * sin(vBeat - 3.6 * u);

  // --- body --------------------------------------------------------------
  // A lens rather than an ellipse: pow(prof, 0.58) is what brings the nose and
  // the tail root to points. An ellipse gives rounded ends and reads as a pill.
  float bx = clamp((q.x - 0.055) / 0.435, -1.0, 1.0);
  float prof = max(0.0, 1.0 - bx * bx);
  float bodyH = 0.118 * pow(prof, 0.58) * mix(0.84, 1.18, smoothstep(-0.95, 0.30, bx));

  // Fins added straight onto the half-heights, so they union with the body.
  float dorsal = (0.070 + 0.030 * uBig) * max(0.0, 1.0 - pow(abs((q.x - 0.02) / 0.30), 1.7));
  float anal = 0.040 * max(0.0, 1.0 - pow(abs((q.x + 0.05) / 0.19), 1.8));
  float upH = bodyH + dorsal;
  float dnH = bodyH * 1.16 + anal;     // the belly is deeper than the back
  float hh = y > 0.0 ? upH : dnH;
  float body = smoothstep(-px, px, hh - abs(y));

  // --- caudal fin --------------------------------------------------------
  // Swept and forked. The notch in the trailing edge is the single feature that
  // separates a fish tail from a dart's flight, and it survives down to a
  // handful of pixels.
  float tw = 0.014 + max(0.0, -0.150 - q.x) * (0.50 + 0.10 * uBig);
  float trail = -0.487 + 0.082 * (1.0 - smoothstep(0.0, 0.15, abs(y)));
  float tailD = min(min(tw - abs(y), -0.128 - q.x), q.x - trail);
  float tail = smoothstep(-px, px, tailD);

  // --- pectoral fin ------------------------------------------------------
  // Small, low on the flank, sculling out of phase with the tail. Two pixels
  // wide in the shoal, but it is what stops the head end looking blunt.
  vec2 pq = vec2(q.x - 0.150, y + 0.048 + 0.020 * sin(vBeat * 0.55));
  float pec = smoothstep(-px, px, 0.030 - length(vec2(pq.x * 0.36, pq.y)));

  float shape = max(max(body, tail), pec * 0.80);
  if (shape < 0.004) discard;

  // --- pigment -----------------------------------------------------------
  // Countershading: dark back, pale belly. Real, and it is also what makes a
  // flat 2D silhouette read as a rounded body.
  float upness = clamp(y / max(hh, 1e-3), -1.0, 1.0);
  float darkTop = smoothstep(-0.20, 0.95, upness);

  // Most fish are cool silver; a small warm minority is what gives the eye
  // somewhere to land on a 6000px wall of blue-green.
  float warm = step(mix(0.865, 0.55, uBig), vTint);
  float hueT = mix(0.575, 0.160, warm);
  float chroma = mix(0.040, 0.155, warm) * (0.75 + 0.55 * fract(vTint * 7.3));
  vec3 col = oklabRamp(0.0, mix(0.88, 0.30, darkTop), chroma, hueT);

  // Vertical barring on the warm fish only, and on the fins of everything.
  float bars = 0.5 + 0.5 * sin(q.x * 32.0 + vTint * 40.0);
  col *= mix(1.0, 0.70 + 0.60 * bars, warm * 0.75);
  col *= mix(0.72, 1.0, body);       // fins are thinner, so more translucent

  // Gill line and eye. At shoal scale the eye is three pixels and it is still
  // the thing that turns the silhouette into an animal.
  col *= 1.0 - 0.22 * exp(-pow((q.x - 0.250) / 0.016, 2.0)) * (1.0 - abs(upness) * 0.6);
  vec2 eq = vec2(q.x - 0.345, y - 0.028);
  float eye = smoothstep(-px, px, 0.0230 - length(eq)) * body;
  col = mix(col, vec3(0.010, 0.013, 0.020), eye * 0.93);
  float glint = smoothstep(-px, px, 0.0085 - length(eq - vec2(0.007, 0.008))) * body;
  col = mix(col, vec3(1.5, 1.7, 1.8), glint * 0.85);

  // --- lighting ----------------------------------------------------------
  // Sampled from the same shaft field the background draws, so a fish crossing
  // a god ray genuinely lights up and dims again on the far side. This is the
  // detail that sells the scene.
  float ray = shaftField(vWorld, uTime);
  float topLit = 0.55 + 0.50 * smoothstep(-1.0, 1.0, upness);
  // The flank flash: fish are mirrors, and a narrow band along the upper flank
  // catching the light is what makes a school sparkle as it turns.
  float flank = exp(-pow((upness - 0.10) * 2.4, 2.0)) * body;
  vec3 lightCol = vec3(0.70, 0.93, 1.00);

  col *= lightCol * (0.62 + 0.55 * topLit + 1.30 * ray);
  col += lightCol * flank * (0.10 + 1.35 * ray) * 0.55;

  // --- depth haze --------------------------------------------------------
  // Distant fish sink into the water colour. Cheap, and convincing enough that
  // it does most of the work of separating the layers.
  vec3 water = waterColor(waterDepth(vWorld));
  float clarity = mix(0.30, 1.0, vDepth);
  col = mix(water * 1.20, col, clarity);

  outColor = vec4(max(col, 0.0), shape * mix(0.70, 1.0, vDepth));
}`

// =============================================================================
// Foreground pass: everything in front of the fish.
// =============================================================================

const FG_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform vec3 uRes;
uniform float uTime;
uniform float uAspect;
uniform vec4 uFgKelpA[${FG_KELP}];
uniform vec4 uFgKelpB[${FG_KELP}];
uniform float uFloorY;
out vec4 outColor;

${GLSL.hash}
${GLSL.simplex2d}
${GLSL.palette}
${WATER_GLSL}
${SHAFT_GLSL}
${KELP_GLSL}

/**
 * Rising bubbles, three depth layers.
 *
 * The lattice scrolls with the content rather than the content moving within a
 * fixed lattice, so a bubble stays attached to its own cell for its whole
 * ascent instead of jumping when it crosses a cell line.
 */
void bubbles(vec2 w, float t, inout vec3 add, inout float cover) {
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float sc = 4.5 + 5.5 * fl;              // cells per world unit
    vec2 p = w * sc;
    p.y -= t * (0.055 + 0.045 * fl) * sc;   // rise
    vec2 g = floor(p);
    vec2 f = p - g;
    vec2 h = rand2(g + fl * 37.0);
    if (h.x > 0.30) continue;               // most cells stay empty
    vec2 h2 = rand2(g + fl * 11.0 + 3.3);
    // Wobble: a bubble spirals as it rises. Bounded so it stays in its cell.
    vec2 c = vec2(0.5 + 0.17 * sin(p.y * 2.6 + h2.x * 40.0), 0.5);
    // In world units, so a bubble is the same fraction of the tank's height on
    // any canvas. Capped near 0.06: at the first attempt the largest were 12%
    // of the frame height, which is bigger than the large fish.
    float r = (0.022 + 0.040 * h2.y) / (1.0 + 0.35 * fl);
    float d = length(f - c);
    if (d > r * 1.15) continue;
    // A bubble is a thin bright shell with a nearly empty middle -- that is
    // what makes it read as a bubble and not as a dot.
    float rim = smoothstep(r, r * 0.88, d) - smoothstep(r * 0.86, r * 0.58, d);
    float fill = smoothstep(r * 0.92, r * 0.55, d);
    float spec = smoothstep(r * 0.30, 0.0, length(f - c - vec2(-0.30, 0.30) * r));
    float k = 1.0 - 0.28 * fl;              // further layers are dimmer
    add += vec3(0.55, 0.85, 0.95) * (rim * 1.5 + spec * 2.2) * k;
    cover = max(cover, fill * 0.16 * k);
  }
}

void main() {
  vec2 w = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;
  float px = 1.0 / uRes.y;
  float ray = shaftField(w, uTime);

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // --- near kelp, deliberately out of focus ------------------------------
  // A couple of very dark blades at the ends of the tank. They frame the 5:1
  // composition and, being obviously nearer than everything else, they are what
  // gives the picture a front as well as a back.
  for (int i = 0; i < ${FG_KELP}; i++) {
    vec4 a = uFgKelpA[i];
    if (abs(w.x - a.x) > a.z + abs(uFgKelpB[i].x) + abs(uFgKelpB[i].y) + 0.1) continue;
    // A wide soft edge stands in for depth of field: a near object the eye is
    // not focused on has no hard silhouette.
    float m = kelpBlade(w, uFloorY - 0.06, a, uFgKelpB[i], uTime, px * 14.0);
    if (m <= 0.0) continue;
    vec3 c = oklabRamp(0.0, 0.17, 0.06, 0.40) + vec3(0.05, 0.11, 0.10) * ray;
    // Only two blades, at opposite ends of the tank, so they never overlap --
    // taking the stronger coverage is exact here rather than an approximation.
    float av = m * 0.82;
    if (av > alpha) { col = c; alpha = av; }
  }

  // --- marine snow -------------------------------------------------------
  // Slow drifting particulate. Almost subliminal, and the frame looks like air
  // without it.
  vec3 add = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float fl = float(L);
    float sc = 26.0 + 22.0 * fl;
    vec2 p = w * sc + vec2(uTime * (0.10 + 0.05 * fl), -uTime * (0.05 + 0.03 * fl));
    vec2 g = floor(p);
    vec2 h = rand2(g + fl * 17.0);
    if (h.x > 0.16) continue;
    float d = length(p - g - vec2(0.25 + 0.5 * h.y, 0.25 + 0.5 * h.x));
    add += vec3(0.50, 0.78, 0.86) * smoothstep(0.13, 0.0, d) * (0.35 - 0.12 * fl);
  }

  float cover = 0.0;
  bubbles(w, uTime, add, cover);
  alpha = max(alpha, cover);

  // Premultiplied output: the kelp occludes (colour times its alpha) while the
  // bubbles and snow are emissive and simply add. One pass, one blend mode.
  outColor = vec4(max(col * alpha + add, 0.0), clamp(alpha, 0.0, 1.0));
}`

// =============================================================================

export default {
  name: 'Aquarium',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let bg = null, fg = null, sim = null, pp = null
    let attrTex = null
    let shoalProg = null, bigProg = null, quads = null, bigQuads = null
    let post = null
    let side = SIDE
    let count = side * side
    let aspect = 1
    let extX = 0.5

    // Drawn in create(), not start(), so a start/stop/start cycle keeps the
    // same tank: same kelp, same shoal temperament, same water.
    const rng = createRng(seedValue)

    // Flocking. Separation must stay well inside the alignment radius, or every
    // neighbour that pushes a fish away also pulls it in, the two cancel and the
    // shoal stops shoaling. They are drawn from disjoint ranges to guarantee it.
    // The separation radius is set relative to a fish *length* (~0.075 world
    // units): below about 0.6 lengths the fish visibly interpenetrate.
    const sepRadius = rng.range(0.072, 0.098)
    const aliRadius = rng.range(0.20, 0.30)
    // Cohesion reaches roughly a shoal-width, not a neighbour-width -- see the
    // sim shader. Below about 0.5 the shoals dissolve over a few minutes.
    const cohRadius = rng.range(0.90, 1.30)
    // Weights are relative only -- the heading is renormalised, so what matters
    // is the balance. Cohesion above alignment gives tighter, rounder shoals;
    // the reverse gives long ribbons. Both look good, hence the ranges.
    // Cohesion is averaged over a much larger disc than alignment, so its raw
    // magnitude is bigger and its weight is correspondingly smaller.
    const weights = [rng.range(2.6, 3.8), rng.range(2.2, 3.6), rng.range(1.1, 1.9)]
    // Pull toward the wandering target, and per-fish wander. The pull has to
    // stay under the flocking terms or the shoal beelines instead of milling.
    // Deliberately the strongest steering term. Flocking alone does not
    // survive ten minutes at this scale: separation sets a minimum spacing,
    // nothing sets a maximum, and every startle stretches a shoal a little
    // further until its members are outside each other's cohesion radius and
    // the tank is uniform wallpaper -- which is exactly what the first three
    // rounds of this looked like at t=90s. A saturating pull toward the
    // shoal's own wandering target is a bait ball's centre: it is what a shoal
    // re-forms *around* after a large fish has been through it.
    const homePull = rng.range(0.22, 0.34)
    const wander = rng.range(0.015, 0.035)
    // Cruise speed in world units per second. The tank is `aspect` units wide,
    // so 0.15 crosses a 5:1 tank in about 33 seconds -- unhurried, which is what
    // an aquarium is for.
    const cruise = rng.range(0.125, 0.175)
    // Turn rate. Under ~2 the fish cannot come about inside the vertical margin
    // even with the urgency boost; over ~5 they snap around like insects.
    const turnRate = rng.range(2.6, 3.8)
    const startleRadius = rng.range(0.13, 0.20)

    // Two or three shoals. Three is the better composition at 5:1 and one is
    // better at 16:9, so the choice is resolved against the aspect in start().
    const shoalCount = rng.int(2, SCHOOLS)
    // Each shoal follows its own sum of three sines. Three rather than one so
    // the path never retraces visibly inside the ten minutes the wall shows it,
    // and the amplitudes sum to under 1 so the target stays inside the tank.
    const shoalPaths = []
    for (let i = 0; i < SCHOOLS; i++) {
      shoalPaths.push({
        // Each shoal gets its own lane down the tank. Without it the three
        // wandering targets are free to coincide, and when they do the shoals
        // merge into one ball and 6000px of wall has a single dense knot in it
        // with nothing either side.
        xc: -0.40 + 0.40 * i,
        ax: [0.28, 0.16, 0.08],
        // Frequencies in Hz. The dominant term has a period of 100-200s, which
        // puts the target's speed at roughly a third of the fish's cruise: fast
        // enough to sweep the tank inside the ten minutes the wall shows this,
        // slow enough that the shoal mills around the target instead of
        // strung out behind a point it can never catch.
        wx: [rng.range(0.005, 0.010), rng.range(0.0028, 0.0060), rng.range(0.011, 0.020)],
        px: [rng.phase(), rng.phase(), rng.phase()],
        wy: [rng.range(0.008, 0.018), rng.range(0.004, 0.010)],
        py: [rng.phase(), rng.phase()],
        // Vertical band centre. Shoals sit at different heights so they do not
        // all occupy the same stripe of a 1200px-tall wall.
        yc: rng.range(-0.15, 0.12),
        ya: rng.range(0.07, 0.15)
      })
    }

    // Large fish. Their motion is a Lissajous path evaluated analytically, with
    // the velocity taken as the exact derivative. That is not laziness: it makes
    // the heading provably consistent with the travel direction (the acceptance
    // criterion the fish sprite orientation has to meet), and it makes leaving
    // the tank impossible without any boundary logic at all.
    const bigCount = rng.int(4, BIG_FISH)
    const bigFish = []
    for (let i = 0; i < BIG_FISH; i++) {
      bigFish.push({
        // x amplitudes sum to 0.88 of the half-width, so a large fish sweeps
        // nearly the whole tank but never reaches the glass.
        axx: [rng.range(0.46, 0.58), rng.range(0.22, 0.34)],
        // Slower than the shoal by design -- a big fish that hurried would look
        // like a big boid. ~0.05-0.10 world units/s against the shoal's 0.15.
        wxx: [rng.range(0.004, 0.009), rng.range(0.007, 0.014)],
        pxx: [rng.phase(), rng.phase()],
        ayy: [rng.range(0.10, 0.17), rng.range(0.045, 0.085)],
        wyy: [rng.range(0.007, 0.015), rng.range(0.017, 0.030)],
        pyy: [rng.phase(), rng.phase()],
        yc: rng.range(-0.14, 0.10),
        // Depth and size. All large fish are near the front so that drawing
        // them over the shoal is the correct occlusion order for most of them;
        // the two furthest are drawn before it (see bigSplit).
        depth: 0,
        size: rng.range(2.6, 4.3),
        tint: rng.next(),
        phase: rng.phase()
      })
    }
    // Sorted small-to-large, then split: the smaller two swim behind the shoal
    // and the rest in front, which is what makes the shoal look like a volume
    // rather than a sheet.
    bigFish.sort((a, b) => a.size - b.size)
    for (let i = 0; i < BIG_FISH; i++) bigFish[i].depth = 0.45 + 0.55 * (i / (BIG_FISH - 1))
    const bigSplit = Math.min(2, bigCount)

    // Kelp. Grouped into clumps rather than spread evenly: evenly spaced plants
    // read as a fence, and the negative space between clumps is what the
    // composition needs at 5:1.
    const kelpClumps = []
    for (let c = 0; c < 3; c++) {
      kelpClumps.push({
        // Stratified thirds with jitter rather than three free draws. Three
        // uniform samples land in the same third often enough to matter, and
        // when they do the whole 6000px tank has plants in one place and bare
        // sand everywhere else.
        at: (-0.62 + 0.62 * c) + rng.around(0, 0.22),        // fraction of the half-width
        spread: rng.range(0.03, 0.09),
        n: rng.int(2, 4)
      })
    }
    const kelp = []
    for (let c = 0; c < kelpClumps.length && kelp.length < KELP; c++) {
      const clump = kelpClumps[c]
      for (let i = 0; i < clump.n && kelp.length < KELP; i++) {
        kelp.push({
          at: clump.at + rng.around(0, clump.spread),
          height: rng.range(0.24, 0.52),
          width: rng.range(0.010, 0.024),
          phase: rng.phase(),
          sway: rng.range(0.035, 0.085) * rng.sign(),
          lean: rng.around(0, 0.09),
          tone: rng.range(0.7, 1.3),
          speed: rng.range(0.22, 0.42)
        })
      }
    }
    // Pad to the fixed array size with blades parked far outside the tank, so
    // the shader's loop bound can stay a compile-time constant.
    while (kelp.length < KELP) {
      kelp.push({ at: 9, height: 0.01, width: 0, phase: 0, sway: 0, lean: 0, tone: 0, speed: 0 })
    }

    const fgKelp = []
    for (let i = 0; i < FG_KELP; i++) {
      fgKelp.push({
        // Pinned near the ends of the tank: a near-black blade through the
        // middle of the picture would cut the composition in half.
        at: (i === 0 ? -1 : 1) * rng.range(0.80, 0.99),
        height: rng.range(0.85, 1.15),
        width: rng.range(0.045, 0.085),
        phase: rng.phase(),
        sway: rng.range(0.05, 0.10) * rng.sign(),
        lean: rng.around(0, 0.10),
        speed: rng.range(0.16, 0.28)
      })
    }

    // God rays. Four beams, placed by a jittered stratification of the width so
    // they never bunch, with one clearly dominant -- a single strong shaft plus
    // supporting ones reads as sunlight; four equal ones read as a pattern.
    const shafts = []
    for (let i = 0; i < 4; i++) {
      shafts.push({
        at: (-0.75 + 0.5 * i) + rng.around(0, 0.12),
        width: rng.range(0.045, 0.11),
        intensity: rng.range(0.35, 0.75),
        phase: rng.phase()
      })
    }
    shafts[rng.int(0, 3)].intensity = rng.range(1.0, 1.5)
    // Which way the sun is. Sheared, not rotated -- see SHAFT_GLSL.
    const shaftLean = rng.range(0.55, 1.35) * rng.sign()

    // Scene tuning that varies per activation without changing the character.
    const floorHeight = rng.range(0.07, 0.12)   // sand depth, world units
    const sandHue = rng.range(0.20, 0.26)       // OKLCH turns: warm ochre
    const causticGain = rng.range(1.1, 1.7)
    const surfaceGain = rng.range(0.90, 1.40)
    const warmShare = rng.range(0.035, 0.095)     // fraction of fish in the accent colour

    /** Static per-fish attributes; see the sim shader for the packing. */
    function seedAttributes() {
      const data = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        // Depth is monotonic in instance id, and instances render in id order,
        // so the shoal composites back-to-front for free -- no sort, no depth
        // buffer. The jitter stays inside one slot so monotonicity holds.
        const depth = (i + rng.range(0.15, 0.85)) / count
        const shoal = rng.int(0, shoalCount - 1)
        // The accent fish are the warm ones; everything else is silver.
        const tint = rng.chance(warmShare) ? rng.range(0.87, 0.999) : rng.range(0.0, 0.86)
        data[i * 4 + 0] = depth
        data[i * 4 + 1] = rng.range(0.82, 1.22)          // size / speed multiplier
        data[i * 4 + 2] = shoal + tint                    // packed: floor = shoal
        data[i * 4 + 3] = rng.next()                      // tail phase, turns
      }
      return data
    }

    /** Initial positions and velocities: each shoal starts as a loose cloud. */
    function seedState() {
      const data = new Float32Array(count * 4)
      const centres = []
      for (let s = 0; s < SCHOOLS; s++) {
        centres.push([rng.range(-0.7, 0.7) * extX, rng.range(-0.15, 0.15)])
      }
      for (let i = 0; i < count; i++) {
        const shoal = Math.min(SCHOOLS - 1, Math.floor(i % shoalCount))
        const c = centres[shoal]
        const a = rng.angle()
        const r = Math.sqrt(rng.next()) * 0.22
        data[i * 4 + 0] = c[0] + Math.cos(a) * r * 1.8
        data[i * 4 + 1] = c[1] + Math.sin(a) * r
        const h = rng.angle()
        data[i * 4 + 2] = Math.cos(h) * cruise
        data[i * 4 + 3] = Math.sin(h) * cruise
      }
      return data
    }

    // Scratch buffers, allocated once: these are uploaded every frame and a
    // fresh Float32Array per frame is exactly the kind of allocation that shows
    // up as GC sawtooth over a ten-minute run.
    const homeBuf = new Float32Array(SCHOOLS * 2)
    const bigA = new Float32Array(BIG_FISH * 4)
    const bigB = new Float32Array(BIG_FISH * 4)

    /** Evaluate a shoal's wandering target at time t. */
    function shoalTarget(p, t, out, i) {
      let x = p.xc
      for (let k = 0; k < 3; k++) x += p.ax[k] * Math.sin(t * p.wx[k] * 6.2831853 + p.px[k])
      let y = 0
      for (let k = 0; k < 2; k++) y += (k === 0 ? 0.62 : 0.38) * Math.sin(t * p.wy[k] * 6.2831853 + p.py[k])
      out[i * 2] = x * extX * 0.92
      out[i * 2 + 1] = p.yc + y * p.ya
    }

    /**
     * Evaluate a large fish's path and its exact derivative.
     *
     * The derivative is the velocity, so the sprite's heading is the direction
     * it is actually travelling by construction rather than by approximation --
     * which is the acceptance criterion that is easiest to fail silently.
     */
    function bigFishAt(f, t, out, i) {
      const w = 6.2831853
      let x = 0, vx = 0, y = 0, vy = 0
      for (let k = 0; k < 2; k++) {
        const wk = f.wxx[k] * w
        x += f.axx[k] * Math.sin(t * wk + f.pxx[k])
        vx += f.axx[k] * wk * Math.cos(t * wk + f.pxx[k])
        const wj = f.wyy[k] * w
        y += f.ayy[k] * Math.sin(t * wj + f.pyy[k])
        vy += f.ayy[k] * wj * Math.cos(t * wj + f.pyy[k])
      }
      out[i * 4 + 0] = x * extX
      out[i * 4 + 1] = f.yc + y
      out[i * 4 + 2] = vx * extX
      out[i * 4 + 3] = vy
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        // Explicit, and load-bearing. createGLRuntime does NOT size the drawing
        // buffer -- it only does that inside runtime.start()'s loop -- so the
        // canvas is still the DOM default 300x150 here and every aspect- or
        // area-derived quantity below would be computed for a 2:1 postage
        // stamp. On the wall that means the tank's world space is 2.5x too
        // narrow: kelp, god rays and the shoal targets all bunch into the
        // middle fifth while clipFromWorld stretches the result back out over
        // the full width, which is exactly the anisotropy issue #114 exists to
        // prevent. Everything from here to the end of start() depends on this.
        runtime.resize()
        aspect = canvasAspect(canvas)
        extX = 0.5 * aspect
        side = particleSide(canvas, SIDE, MAX_SIDE)
        count = side * side

        pp = createPingPong(gl, side, side, seedState())
        attrTex = createFloatTarget(gl, side, side, seedAttributes())
        sim = createFullscreenPass(gl, simFragment(side))
        bg = createFullscreenPass(gl, BG_FRAG)
        fg = createFullscreenPass(gl, FG_FRAG)
        shoalProg = buildProgram(gl, SHOAL_VERT, FISH_FRAG)
        bigProg = buildProgram(gl, BIG_VERT, FISH_FRAG)
        quads = createInstancedQuads(gl, shoalProg.program)
        bigQuads = createInstancedQuads(gl, bigProg.program)

        const uSim = createUniformCache(gl, sim.program)
        const uBg = createUniformCache(gl, bg.program)
        const uFg = createUniformCache(gl, fg.program)
        const uShoal = createUniformCache(gl, shoalProg.program)
        const uBigP = createUniformCache(gl, bigProg.program)

        // Fish length in device pixels. 46px at 1080p is about 4% of the height
        // -- large enough that the SDF's eye and forked tail resolve, small
        // enough that a few hundred still leave water between them. pointScale
        // takes it to ~86px on the wall, holding the angular size roughly
        // constant for a viewer standing further back (#88).
        const fishPx = 46 * pointScale(canvas, 46)

        // The free-swimming box, and the margin the fish turn around in.
        // Asymmetric vertically: the sand and the surface are both scene, not
        // swimming room, and the bottom margin is the wider of the two because
        // the kelp is down there.
        // The top bound plus its margin stops just under where the surface
        // skin starts, so no fish is ever drawn against the bright band -- a
        // fish silhouetted on the surface reads as a bird against sky.
        const bounds = [-extX + 0.34, extX - 0.34, -0.5 + floorHeight + 0.14, 0.20]
        const margin = [0.30, 0.16]

        // Flattened uniform arrays, built once: kelp does not move between
        // frames, only its sway phase does, and that is evaluated in GLSL.
        const kelpA = new Float32Array(KELP * 4)
        const kelpB = new Float32Array(KELP * 4)
        for (let i = 0; i < KELP; i++) {
          const k = kelp[i]
          kelpA.set([k.at * extX, k.height, k.width, k.phase], i * 4)
          kelpB.set([k.sway, k.lean, k.tone, k.speed], i * 4)
        }
        const fgA = new Float32Array(FG_KELP * 4)
        const fgB = new Float32Array(FG_KELP * 4)
        for (let i = 0; i < FG_KELP; i++) {
          const k = fgKelp[i]
          fgA.set([k.at * extX, k.height, k.width, k.phase], i * 4)
          fgB.set([k.sway, k.lean, 1, k.speed], i * 4)
        }
        const shaftX = new Float32Array(4)
        const shaftW = new Float32Array(4)
        const shaftI = new Float32Array(4)
        const shaftP = new Float32Array(4)
        for (let i = 0; i < 4; i++) {
          shaftX[i] = shafts[i].at * extX
          shaftW[i] = shafts[i].width * Math.max(1, aspect * 0.45)
          shaftI[i] = shafts[i].intensity
          shaftP[i] = shafts[i].phase
        }

        /** Bind the shaft uniforms, which four of the five programs sample. */
        const bindShafts = (u) => {
          gl.uniform4fv(u('uShaftX'), shaftX)
          gl.uniform4fv(u('uShaftW'), shaftW)
          gl.uniform4fv(u('uShaftI'), shaftI)
          gl.uniform4fv(u('uShaftP'), shaftP)
          gl.uniform1f(u('uShaftLean'), shaftLean)
        }

        // HDR in, bloom on the genuinely bright things only. The threshold sits
        // just above the brightest *water*, so the surface shimmer, the caustic
        // peaks, the bubble rims and a fish flashing its flank in a shaft glow,
        // and the general body of the tank does not.
        //
        // Exposure carries the big-room lift rather than a black-level tint:
        // multiplying linear colour leaves black at black and buys the headroom
        // out of the bright end, where this scene actually has some.
        const lum = luminanceScale(canvas)
        post = createPostChain(gl, canvas, {
          // Threshold measured, not guessed (see post-fx.js). The water column
          // peaks around 0.35, a lit fish flank around 1.0 and the surface's
          // average around 0.5; only the ripple crests, the caustic filaments
          // on the sand and the bubble rims run past 1.3. Setting it there is
          // what keeps the bloom a sparkle rather than a fog.
          bloom: { threshold: 1.30, knee: 0.40, intensity: 0.40, radius: 1.0 },
          tonemap: 'aces',
          exposure: 1.0 + (lum - 1.0) * 0.6,
          dither: true
        })

        runtime.start((time, frameCount, glCtx, rt) => {
          const dt = rt.dt

          // --- shoal simulation ------------------------------------------
          for (let i = 0; i < SCHOOLS; i++) shoalTarget(shoalPaths[i], time, homeBuf, i)
          for (let i = 0; i < BIG_FISH; i++) {
            if (i < bigCount) {
              bigFishAt(bigFish[i], time, bigA, i)
            } else {
              // Parked far outside the tank so the startle loop, whose bound is
              // a compile-time constant, simply never triggers on them.
              bigA.set([1000, 1000, 1, 0], i * 4)
            }
            const f = bigFish[i]
            bigB.set([f.depth, fishPx * f.size, f.tint, f.phase], i * 4)
          }

          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, side, side)
          sim.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(uSim('uState'), 0)
            g.activeTexture(g.TEXTURE1)
            g.bindTexture(g.TEXTURE_2D, attrTex.tex)
            g.uniform1i(uSim('uAttr'), 1)
            g.uniform2f(uSim('uTexel'), 1 / side, 1 / side)
            g.uniform1f(uSim('uDt'), dt)
            g.uniform1f(uSim('uTime'), time)
            g.uniform1f(uSim('uAspect'), aspect)
            g.uniform3f(uSim('uRadii'), sepRadius, aliRadius, cohRadius)
            g.uniform3f(uSim('uWeights'), weights[0], weights[1], weights[2])
            g.uniform2fv(uSim('uHome'), homeBuf)
            g.uniform2f(uSim('uPull'), homePull, wander)
            g.uniform2f(uSim('uSpeed'), cruise, 0)
            g.uniform1f(uSim('uTurn'), turnRate)
            g.uniform4f(uSim('uBounds'), bounds[0], bounds[1], bounds[2], bounds[3])
            g.uniform2f(uSim('uMargin'), margin[0], margin[1])
            g.uniform4fv(uSim('uBig'), bigA)
            g.uniform1f(uSim('uStartle'), startleRadius)
          })
          pp.swap()
          gl.activeTexture(gl.TEXTURE0)

          // --- scene -----------------------------------------------------
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)

          // Background is opaque and redrawn every frame -- there is nothing to
          // accumulate here, so no trail fade and no ghosting.
          gl.disable(gl.BLEND)
          bg.draw((g) => {
            g.uniform3f(uBg('uRes'), canvas.width, canvas.height, 1)
            g.uniform1f(uBg('uTime'), time)
            g.uniform1f(uBg('uAspect'), aspect)
            g.uniform4fv(uBg('uKelpA'), kelpA)
            g.uniform4fv(uBg('uKelpB'), kelpB)
            g.uniform4f(uBg('uTuning'), floorHeight, sandHue, causticGain, surfaceGain)
            bindShafts(uBg)
          })

          // Fish composite over the water, so straight alpha, back to front.
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

          /** Draw a run of large fish; `base` is the first index. */
          const drawBig = (base, n) => {
            if (n <= 0) return
            gl.useProgram(bigProg.program)
            gl.uniform4fv(uBigP('uBigA'), bigA)
            gl.uniform4fv(uBigP('uBigB'), bigB)
            gl.uniform1i(uBigP('uBase'), base)
            gl.uniform2f(uBigP('uQuadScale'), 2 / canvas.width, 2 / canvas.height)
            gl.uniform1f(uBigP('uAspect'), aspect)
            gl.uniform1f(uBigP('uTime'), time)
            gl.uniform1f(uBigP('uBig'), 1)
            bindShafts(uBigP)
            bigQuads.draw(n)
          }

          // The furthest large fish go behind the shoal, the rest in front. The
          // shoal itself needs no sorting: attribute depth is monotonic in
          // instance id and instances draw in id order.
          drawBig(0, bigSplit)

          gl.useProgram(shoalProg.program)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(uShoal('uState'), 0)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, attrTex.tex)
          gl.uniform1i(uShoal('uAttr'), 1)
          gl.uniform1f(uShoal('uSide'), side)
          gl.uniform1f(uShoal('uSizePx'), fishPx)
          gl.uniform2f(uShoal('uQuadScale'), 2 / canvas.width, 2 / canvas.height)
          gl.uniform1f(uShoal('uAspect'), aspect)
          gl.uniform1f(uShoal('uTime'), time)
          gl.uniform1f(uShoal('uBig'), 0)
          bindShafts(uShoal)
          quads.draw(count)
          gl.activeTexture(gl.TEXTURE0)

          drawBig(bigSplit, bigCount - bigSplit)

          // Foreground is premultiplied: the near kelp occludes and the bubbles
          // add, in one pass.
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
          fg.draw((g) => {
            g.uniform3f(uFg('uRes'), canvas.width, canvas.height, 1)
            g.uniform1f(uFg('uTime'), time)
            g.uniform1f(uFg('uAspect'), aspect)
            g.uniform4fv(uFg('uFgKelpA'), fgA)
            g.uniform4fv(uFg('uFgKelpB'), fgB)
            g.uniform1f(uFg('uFloorY'), -0.5 + floorHeight)
            bindShafts(uFg)
          })
          gl.disable(gl.BLEND)

          if (post) post.present()
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (bg) { bg.destroy(); bg = null }
        if (fg) { fg.destroy(); fg = null }
        if (shoalProg) { shoalProg.destroy(); shoalProg = null }
        if (bigProg) { bigProg.destroy(); bigProg = null }
        if (quads) { quads.destroy(); quads = null }
        if (bigQuads) { bigQuads.destroy(); bigQuads = null }
        if (pp) { pp.destroy(); pp = null }
        if (attrTex) {
          gl.deleteTexture(attrTex.tex)
          gl.deleteFramebuffer(attrTex.fbo)
          attrTex = null
        }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
