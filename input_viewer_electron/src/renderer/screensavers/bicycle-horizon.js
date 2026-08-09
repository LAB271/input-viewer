// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Bicycle Horizon -- a first-person ride along a coastal path (issue #81).
 *
 * Trees and a grass verge on one side, a sea wall and open water on the other,
 * a tarmac path running to a vanishing point, and the rider's handlebars fixed
 * in the lower frame.
 *
 * APPROACH (decided on the issue before any code)
 *
 * Option B, layered 2.5D parallax -- sky, distant hills, mid trees, near
 * grass, a perspective-mapped road, fixed handlebars -- but with every layer
 * *generated* rather than sourced as art. That keeps the bundle cost at zero
 * and matches the asset-free architecture of the rest of the folder, while
 * still getting the layer structure that makes option B read as depth. There
 * is no video, no sprite sheet and no texture upload: one fragment shader.
 *
 * PROJECTION -- why cylindrical, and why the frame is composed not photographed
 *
 * The wall is 6000x1200. A rectilinear camera wide enough to fill 5:1 would
 * stretch the edges grotesquely, so the horizontal axis is a *cylindrical*
 * projection: azimuth is linear in screen x. The horizon stays a straight
 * line, verticals stay vertical, and a 140-degree view fits without the corner
 * smear. The vertical axis is the tangent of elevation, as in an ordinary
 * pinhole camera, so the ground still recedes correctly.
 *
 * One consequence is load-bearing and worth stating plainly. With a vertical
 * span of ~57 degrees over 1200px and 140 degrees over 6000px, the horizontal
 * scale is about 2.2x compressed relative to the vertical. That is the price of
 * showing a 5:1 slice of the world at all, and it is the *right* price here: a
 * road receding to a vanishing point is exactly the subject a very wide frame
 * flatters, because the interesting structure is horizontal.
 *
 * It also means real handlebar geometry does not fit. A bar 0.55m ahead and
 * 0.5m below the eye sits at -42 degrees elevation; the bottom of this frame is
 * -30. So the bars are *composed* into the lower frame at a plausible scale
 * rather than projected from the bike -- which is what the painted reference in
 * the issue does too. Everything behind them is projected honestly.
 *
 * COMPOSITION AT 5:1
 *
 * Designed for 6000x1200 from the start, not cropped from the portrait
 * reference. The reading, left to right: a heavy dark tree mass filling one
 * end, the path sweeping through the lower middle to a vanishing point near
 * centre, then a widening wedge of open water and sky taking the other half.
 * The handlebars anchor the bottom centre across about 40% of the width, so the
 * two ends of the frame stay open -- the negative space is the point, and on a
 * 10m wall a uniformly busy frame is the standard failure.
 *
 * The path curves, so the vanishing point travels laterally across the middle
 * third rather than sitting nailed to the centre. Which side the sea is on is
 * drawn from the seed, so the frame does not always read the same way round.
 *
 * LAYERS
 *
 * Everything vertical is a "curtain": a plane parallel to the path at a fixed
 * lateral offset, carrying a silhouette. This is the one trick the whole saver
 * rests on, so it is worth spelling out. For a curtain at lateral offset X and a
 * ray at world azimuth t, the horizontal distance to it is just X / sin(t) --
 * a closed form, no marching. So one inversion per pixel places a tree line
 * perfectly in perspective, converging on the vanishing point, with real
 * parallax between layers falling out for free because each layer has its own
 * X and therefore its own distance-vs-azimuth curve.
 *
 * Curtains never need depth sorting against the ground either: a curtain is
 * only visible where its world height is above zero, which happens exactly
 * where it is nearer than the ground at that pixel. So the ground is painted
 * first and the curtains composite over it, far to near.
 *
 * ANTI-ALIASING
 *
 * No supersampling. Every edge in the scene -- canopy silhouettes, road edges,
 * surf lines, grass -- is a smoothstep whose width comes from the *analytic*
 * screen-space derivative of the coordinate it is cut in. Those derivatives are
 * exact here (d = X/sin(t) and d = h/-v differentiate in closed form), which is
 * both cheaper and better than 2x samples: near the vanishing point the filter
 * width grows without bound and the detail dissolves into haze instead of
 * boiling. A fixed sample count cannot do that at any price.
 *
 * TIME OF DAY, AND EXPOSURE
 *
 * A 25-minute arc drives sun elevation and azimuth, and everything else follows
 * from those two numbers: sky and haze colour, whether the trees are front-lit
 * green or backlit silhouettes, which way their shadows fall across the path,
 * and where the glitter path sits on the water. The rotation shows each saver
 * for 10 minutes, so no two showings are the same part of the arc, and the
 * per-activation seed offsets the phase so it is not the same part each day.
 *
 * The illumination is then *exposure-adapted* rather than left at its physical
 * level -- see the note above gSunI in the shader. Golden hour is genuinely
 * four times darker on the ground than noon, and rendering that faithfully just
 * produces an underexposed frame, which on a lit wall is the one failure this
 * saver cannot afford. The sun/sky ratio is what carries the mood, so that is
 * what is preserved; the absolute level is not.
 */
import { createShaderScreensaver } from './gl-base.js'
import { GLSL } from './glsl-lib.js'

const SHADER = /* glsl */ `${GLSL.hash}
${GLSL.simplex2d}
${GLSL.fbm}
${GLSL.palette}

const float TAU = 6.28318530718;

// ---------------------------------------------------------------- the world
//
// Metres and seconds throughout. World axes: +z is forward along the path, +x
// is lateral (positive = the sea side), +y is up.

const float EYE_H  = 1.52;   // eye height of someone sitting up on a city bike
const float SPEED  = 6.4;    // m/s, ~23 km/h: brisk, not racing

// Lateral offsets of every layer, from the centre of the path. Negative is the
// tree side. These are the composition: the numbers decide how much of the
// frame each mass occupies, far more than any colour choice does.
//
// The sea is deliberately *close*, and the wall between path and water is
// deliberately *low*. On a 5:1 frame the ground band is only half the height,
// so lateral distance converts almost entirely into proximity to the horizon:
// the first pass put the waterline at 9m behind a 0.9m wall and the sea came
// out as a grey ribbon, because the wall alone occluded everything from 15 to
// 37 percent below the horizon. A 0.32m kerb at 3.0m and water from 4.3m opens
// the sea into a wedge ~180px deep at the frame edge, which is what makes that
// half of the composition work.
const float ROAD_HALF  = 1.45;   // tarmac half-width
const float SHOULDER   = 0.42;   // gravel fringe either side
const float VERGE_L    = -2.35;  // rough grass, tree side
const float VERGE_R    = 2.30;   // rough grass, sea side
const float WALL_X     = 3.00;   // kerb at the top of the shingle
const float SHORE_X    = 4.30;   // mean waterline
const float TREE_X     = -7.00;  // the big trees: the dark mass of the frame
const float HEDGE_X    = -4.20;  // scrub at the foot of the tree line
const float MIDTREE_X  = -16.5;
const float FARTREE_X  = -68.0;
const float HILL_L     = -1250.0;
const float HILL_R     = 1450.0;

// Canopy geometry for the near tree line. Spacing against radius is what sets
// how much sky shows between trunks, and that is the difference between a row
// of trees and a solid green wall.
const float TREE_SPACING = 10.5;
const float TREE_RADIUS  = 4.7;

// Projection. 140 degrees horizontally is wide enough to fill 5:1 without the
// vertical FOV collapsing to a letterbox slit; VSPAN is the tangent of
// elevation covered from the bottom of the frame to the top.
const float HFOV    = 2.44;
const float VSPAN   = 1.06;
const float HORIZON = 0.555;  // horizon height as a fraction of the frame

// Screen roll gain. A cyclist genuinely leans ~4 degrees into a bend this
// gentle, but on a 5:1 frame a roll of r tilts the horizon by r * 2.5 frame
// heights end to end -- 4 degrees would swing the horizon through 190px and
// read as a boat, not a bicycle. A third of the true lean, hard-clamped, keeps
// the cue without the seasickness.
const float ROLL_GAIN = 0.30;
const float ROLL_MAX  = 0.020;

// Pedalling cadence in Hz (~81 rpm). Drives the bob, the sway and the bar
// movement; the issue is right that this is what stops a fixed foreground
// reading as a sticker.
const float CADENCE = 1.35;

// Full dawn-to-dusk arc. 25 minutes against a 10-minute rotation slot means a
// showing never repeats the light it opened with, and never sees the whole arc.
const float TOD_PERIOD = 1500.0;

// ------------------------------------------------------- per-pixel globals
//
// GLSL has no closures and threading fifteen camera and lighting values through
// every helper would bury the geometry, so the scene state lives here and is
// filled in once at the top of mainImage.
float gT;        // scene time, offset per activation
float gCamX, gCamZ, gCamH, gYaw;
float gP1, gP2;  // path phases, per activation
vec3  gSun;      // unit vector toward the sun
vec3  gSunI;     // exposure-adapted direct sunlight
vec3  gAmb;      // exposure-adapted sky fill
vec3  gSkyLo;    // horizon sky
vec3  gSkyHi;    // zenith
vec3  gHaze;     // aerial-perspective colour
float gDTheta;   // radians of azimuth per pixel
float gDV;       // v units per pixel

/**
 * OKLab -> linear RGB with lightness, chroma and hue-in-turns.
 *
 * Every colour in this saver goes through here rather than being written as an
 * RGB triple. Grass, water and sky all want to move in lightness without
 * sliding in hue as they haze out, and sRGB interpolation does not do that --
 * it drags saturated greens through mud on the way to grey, which is exactly
 * how a landscape shader ends up looking like a landfill.
 *
 * Hue in turns from the +a axis: 0.0 red, 0.13 orange, 0.25 yellow,
 * 0.40 green, 0.55 cyan, 0.72 sky blue, 0.82 violet.
 *
 * L above 1.0 is legal and deliberate -- that is how the sun disk, lit cloud
 * tops, water glitter and the chrome on the bar get into HDR for the bloom.
 */
vec3 ok(float L, float C, float hue) {
  float a = TAU * hue;
  return max(oklabToLinear(vec3(L, C * cos(a), C * sin(a))), 0.0);
}

/**
 * Detail fade for a feature of a given world size, given the screen-space
 * filter width at this pixel.
 *
 * Returns 1 where a pixel is much smaller than the feature and 0 where the
 * feature is smaller than a pixel. Multiplying a detail term by this is what
 * lets grass, asphalt speckle, cracks and wave chop all vanish smoothly into
 * their own average instead of aliasing into a boiling mess near the horizon --
 * where, on a 6000px-wide frame, most of the ground area actually is.
 */
float lodFade(float w, float feature) {
  return 1.0 - smoothstep(feature * 0.55, feature * 2.4, w);
}

// The path's centre line, its slope and its curvature. Two sinusoids: one long
// enough to swing the vanishing point across the middle third of the frame, one
// short enough that the swing is never a straight line for long.
//
// The amplitudes are bounded, and the bound is load-bearing rather than
// aesthetic. curtainDist() solves d = (off + pathX(z) - camX) / sin(theta) by
// fixed point; that is well conditioned only while the total path excursion
// stays below the offset of the curtain being solved for. Above it the
// numerator can cross zero in the same place sin(theta) does, the solver lands
// on a spurious near root, and a whole tree line gets drawn three metres in
// front of the rider as a spire up the middle of the frame. 3.4 + 1.05 = 4.45m
// of excursion against the 7m tree line leaves comfortable margin.
const float PATH_A1 = 3.40, PATH_K1 = 0.0242;   // ~260m wavelength
const float PATH_A2 = 1.05, PATH_K2 = 0.0741;   // ~85m
float pathX(float z) {
  return PATH_A1 * sin(z * PATH_K1 + gP1) + PATH_A2 * sin(z * PATH_K2 + gP2);
}
float pathSlope(float z) {
  return PATH_A1 * PATH_K1 * cos(z * PATH_K1 + gP1)
       + PATH_A2 * PATH_K2 * cos(z * PATH_K2 + gP2);
}
float pathCurve(float z) {
  return -PATH_A1 * PATH_K1 * PATH_K1 * sin(z * PATH_K1 + gP1)
         - PATH_A2 * PATH_K2 * PATH_K2 * sin(z * PATH_K2 + gP2);
}

/**
 * Horizontal distance from the eye to a curtain standing parallel to the path
 * at lateral offset off. Returns -1 when the ray never reaches it.
 *
 * For a straight path this inverts exactly: d = off / sin(theta). The path
 * curves, so the curtain does too, and three fixed-point steps fold that in --
 * without them the tree line detaches from the road through a bend, which is
 * the single most obvious way this trick breaks.
 *
 * The correction is faded out toward the vanishing point, and that is a
 * stability fix rather than a cosmetic one. The iteration's convergence factor
 * is pathSlope * cos(theta) / sin(theta), which passes 1 at about
 * |sin(theta)| < 0.16 and diverges from there. Left alone, the solve then lands
 * somewhere different on adjacent pixels and the tree line breaks up into a
 * band of semi-transparent horizontal streaks either side of the vanishing
 * point -- which is exactly what it did. Where the correction is faded out the
 * inversion is the exact straight-line one, and the row is unresolved there in
 * any case, so treeLayer has already swapped it for its average silhouette and
 * a few metres of error in the distance costs nothing but haze.
 */
float curtainDist(float s, float c, float off) {
  if (off * s <= 1e-4) return -1.0;
  float corr = smoothstep(0.10, 0.32, abs(s));
  float d = off / s;
  for (int i = 0; i < 3; i++) {
    d = clamp(d, 0.5, 4000.0);
    d = (off + corr * (pathX(gCamZ + d * c) - gCamX)) / s;
    if (d <= 0.0) return -1.0;
  }
  return clamp(d, 0.5, 4000.0);
}

/**
 * Screen-space filter footprint on a curtain at distance d, in metres:
 * .x along the curtain, .y vertically.
 *
 * Both derivatives are closed form. Along the curtain, u = camZ + d*cos(t), so
 * du/dt collapses to -d/sin(t). Note that it is written in terms of the
 * *solved* d and not of the nominal offset: on a bend the curtain can pass much
 * closer to the line of sight than its nominal offset suggests, and the
 * d^2/offset form then understates the derivative by two orders of magnitude.
 * That was the cause of the row of 100m-tall needles the first version drew
 * down the horizon -- each one a real tree at 60m, sampled through a 2.4m-wide
 * slice and filtered as though it were 0.01m. Vertically, world height is
 * camH + d*v, so it scales with d directly.
 *
 * The two are returned separately because the ratio between them is the whole
 * problem near the vanishing point. du grows as d^2 while dy grows as d, so at
 * 400m one pixel column spans several trees while the same pixel spans only a
 * fraction of a crown vertically. Filtering that isotropically samples a random
 * *slice* of the canopy, and a tall crown sliced thinly is a needle -- which is
 * exactly what the first version drew: a picket fence of spikes down the
 * horizon. treeLayer uses .x to decide when the row is unresolved and swap to
 * its average silhouette instead.
 */
vec2 curtainWidth(float d, float v, float s, float c) {
  float du = (d / max(abs(s), 1e-4)) * gDTheta;
  float dy = d * gDV + abs(v) * (d * abs(c) / max(abs(s), 1e-3)) * gDTheta;
  return vec2(du, dy) + 1e-4;
}

/**
 * Collapse a footprint to one number for the layers whose silhouette is a
 * height field rather than a shape: there the along-curtain axis only ever
 * blurs the profile, so an isotropic width is the right filter and the cap
 * stops it swallowing the layer whole at the vanishing point.
 */
float flatWidth(vec2 wv, float cap) {
  return min(0.5 * (wv.x + wv.y), cap);
}

/** Fade a curtain out at the exact column where its distance diverges. */
float curtainFade(float s) {
  return smoothstep(0.0, 0.050, abs(s));
}

// ------------------------------------------------------------------- trees
//
// A tree line is a signed distance field in (u, y): u is world z along the
// curtain, y is height above the ground. Trees are placed one per cell with
// jittered position, radius and height; three cells is enough neighbourhood
// because the jitter is bounded well inside one spacing.

struct Tree { float u; float h; float r; };

Tree treeAt(float ci, float spacing, float radius, float seedOff) {
  vec2 r1 = rand2(vec2(ci, seedOff));
  float r2 = rand(vec3(ci, seedOff, 7.31));
  Tree t;
  t.u = (ci + 0.5 + (r1.x - 0.5) * 0.55) * spacing;
  t.r = radius * (0.70 + 0.48 * r1.y);
  // Crown centre height as a multiple of crown radius. Two failure modes sit
  // either side of this number: above ~2.3 every tree is a lollipop on a bare
  // pole, and below ~1.1 the crown swallows the trunk and the row becomes an
  // undifferentiated green wall with nothing behind it. 1.35-1.85 leaves a
  // couple of metres of visible trunk under each canopy.
  t.h = t.r * (1.35 + 0.50 * r2);
  return t;
}

/** Highest point of the canopy near world z. Used for shadow casting. */
float canopyTop(float z, float spacing, float radius, float seedOff) {
  float cell = floor(z / spacing);
  float top = 0.0;
  for (int i = -1; i <= 1; i++) {
    Tree t = treeAt(cell + float(i), spacing, radius, seedOff);
    // Only count a tree that is actually overhead, so the shadow bands have
    // gaps between them rather than being one continuous strip.
    float reach = 1.0 - smoothstep(t.r * 0.8, t.r * 1.45, abs(z - t.u));
    top = max(top, (t.h + t.r * 1.15) * reach);
  }
  return top;
}

/**
 * Canopy SDF, roughly unit-gradient in metres.
 *
 * Three overlapping lobes per tree rather than one: a single ellipse reads as a
 * lollipop, and the asymmetry of the smaller lobes is most of what makes the
 * mass look painted instead of stamped. The noise term is amplitude-limited so
 * the gradient stays inside [0.7, 1.3] and the smoothstep widths above still
 * mean what they say.
 */
float treeField(float u, float y, float spacing, float radius, float seedOff) {
  float cell = floor(u / spacing);
  float best = 1e6;
  for (int i = -1; i <= 1; i++) {
    float ci = cell + float(i);
    Tree t = treeAt(ci, spacing, radius, seedOff);
    vec3 j = vec3(rand(vec3(ci, seedOff, 2.1)), rand(vec3(ci, seedOff, 4.7)),
                  rand(vec3(ci, seedOff, 8.3))) - 0.5;
    float da = length(vec2(u - t.u, (y - t.h) / 1.05)) - t.r;
    float db = length(vec2(u - t.u - t.r * j.x * 1.5,
                           (y - t.h + t.r * 0.55) / 1.05)) - t.r * 0.80;
    float dc = length(vec2(u - t.u + t.r * j.y * 1.4,
                           (y - t.h - t.r * 0.60) / 1.10)) - t.r * 0.66;
    // Trunk: a tapering box from the ground up into the crown. Wide enough to
    // survive being a couple of pixels across at 60m, or the canopies float.
    float taper = t.r * (0.175 - 0.065 * clamp(y / max(t.h, 0.1), 0.0, 1.0));
    vec2 tq = vec2(abs(u - t.u + t.r * j.z * 0.25) - taper,
                   abs(y - t.h * 0.40) - t.h * 0.40);
    float dt = min(max(tq.x, tq.y), 0.0) + length(max(tq, 0.0));
    best = min(best, min(min(da, db), min(dc, dt)));
  }
  // Two scales of lumpiness: a coarse one that breaks the ellipse, and a finer
  // one that makes the edge leafy rather than smoothly blobby. Amplitudes are
  // sized so the total gradient stays inside [0.65, 1.35] and the smoothstep
  // widths elsewhere still mean metres.
  return best - radius * (0.16 * fbm(vec2(u, y) * (1.5 / radius), 3)
                        + 0.055 * fbm(vec2(u, y) * (5.0 / radius) + 31.0, 2));
}

/**
 * Shade and composite one tree curtain. Returns rgb + coverage.
 *
 * The lighting is deliberately two-sided. A curtain's visible face normal is
 * (-sign(off), 0, 0), so when the sun is on the far side of the path the trees
 * go to dark backlit silhouettes with a glowing rim, and when it is on the tree
 * side they open up into lit green. That single dot product is the reason the
 * scene looks materially different at different points in the day cycle.
 */
vec4 treeLayer(float d, float u, float y, vec2 wv, float off, float seedOff,
               float spacing, float radius, float hue, float hazeDist, vec3 rd) {
  if (d <= 0.0 || y < -0.4) return vec4(0.0);

  // A curtain is a flat stand-in for a row of solid trees, and the two stop
  // agreeing once the row is viewed nearly end-on. There, one pixel column
  // spans many metres *along* the row but only centimetres vertically, so a
  // crown gets sampled through a sliver and draws as a needle -- a picket fence
  // of them down the horizon, which is what the first version did.
  //
  // What a real avenue does end-on is close up into a solid wall of foliage:
  // the crowns overlap, the gaps disappear and the silhouette rises to the
  // tallest tree rather than the average one. So past a threshold on the
  // anisotropy the row is swapped for exactly that band, with its fill and its
  // height both derived from how many trees fall inside one pixel.
  // Two independent ways to lose the row, and both are needed. The anisotropy
  // catches the end-on case, but it saturates: wv.y contains |v| * wv.x, so
  // aniso can never exceed 1/|v| and high up a tall tree it stays small however
  // huge the along-row footprint gets. The second term is the plain question of
  // whether a crown still covers more than a pixel.
  // A healthy tree sits at aniso near 1: the rendered aspect works out as
  // 0.8/aniso and a crown is about as wide as it is tall, so the threshold is
  // where the shape has stretched past 2:1 of its proper proportions. The
  // anisotropy also saturates -- wv.y contains |v| * wv.x, so aniso can never
  // exceed 1/|v|, and high up a tall tree it stays small however huge the
  // along-row footprint gets. Hence the second term, which is the plain
  // question of whether a crown still covers a few pixels.
  float aniso = wv.x / max(wv.y, 1e-5);
  float unres = max(smoothstep(1.8, 4.0, aniso),
                    smoothstep(radius * 0.35, radius * 1.0, wv.x));
  float res = 1.0 - unres;
  float w = min(0.5 * (wv.x + wv.y), radius * 0.6);

  float perPixel = max(wv.x / spacing, 1.0);
  float fill = clamp(2.0 * radius * 0.94 / spacing, 0.2, 1.0);
  float fillEff = 1.0 - pow(1.0 - fill, perPixel);
  // Undulation of the row's skyline. It has to be faded out on the same terms
  // as everything else: sampled where one pixel spans hundreds of metres of u
  // it aliases into a staircase of blocks along the horizon, which is what the
  // band was drawn as before this line existed.
  float undul = mix(1.0, 0.88 + 0.24 * (0.5 + 0.5 * snoise(vec2(u / (spacing * 6.0), seedOff))),
                    lodFade(wv.x, spacing * 2.5));
  float bandTop = radius * mix(2.30, 2.80, clamp((perPixel - 1.0) * 0.25, 0.0, 1.0)) * undul;
  // Always soft: the band is a stand-in for something unresolved, so a hard
  // edge on it would be a lie the eye picks up immediately.
  float bw = max(wv.y, radius * 0.16);
  float bandCov = (1.0 - smoothstep(-bw, bw, y - bandTop)) * fillEff;

  float f = 1e6;
  float cov = bandCov;
  if (unres < 0.999) {
    f = treeField(u, y, spacing, radius, seedOff);
    if (f > w * 2.0 + 0.4 && unres < 0.002) return vec4(0.0);
    cov = mix(1.0 - smoothstep(-w, w, f), bandCov, unres);
  }
  if (cov <= 0.002) return vec4(0.0);

  // Everything from here down is detail in (u, y), so all of it is gated on
  // res as well as on its own LOD term. Once the row has been swapped for its
  // band, f is meaningless, and leaving these running against it is what
  // painted a fish-scale mottle across the whole middle distance: fine noise
  // sampled where one pixel spans tens of metres of u.
  //
  // Sky holes first. Real canopies are perforated near their edges and solid in
  // the middle; punching holes everywhere would dissolve the silhouette that
  // the composition depends on.
  float holeN = 0.5 + 0.5 * snoise(vec2(u, y) * (3.1 / radius) + seedOff);
  float edge = smoothstep(-radius * 0.85, -radius * 0.04, f);
  cov *= 1.0 - 0.40 * smoothstep(0.46, 0.88, holeN) * edge * res
         * lodFade(wv.x, radius * 0.30);

  // Clump shading. The same trick as the cloud deck: sample the foliage noise
  // once in place and once a little way toward the sun, and take the difference
  // as a stand-in for a surface normal. Two fbm calls buy the whole difference
  // between a flat green cut-out and a mass with lit tops and shaded hollows,
  // which no amount of edge-distance shading can fake.
  float form = 0.5;
  float leaf = 0.0;
  if (res > 0.004) {
    float wind = 0.10 * sin(gT * 0.55 + u * 0.13);
    vec2 cp = vec2(u + wind, y) * (1.5 / radius);
    float clump = fbm(cp, 3);
    float clumpSun = fbm(cp + normalize(vec2(gSun.z, gSun.y) + 1e-4) * 0.9, 2);
    form = clamp((clumpSun - clump) * 2.4 + 0.5, 0.0, 1.0);
    form = mix(0.5, form, res * lodFade(wv.x, radius * 0.75));
    leaf = fbm(vec2(u + wind, y) * (2.2 / radius), 3)
           * res * lodFade(wv.x, radius * 0.30);
  }
  // Depth into the mass, 1 at the silhouette edge. The range has to be a
  // *fraction* of the radius: the first pass used 1.45x, which no point inside
  // a crown of that radius can ever reach, so ao was pinned near 1 everywhere
  // and the backlit rim below lit up entire trees as glowing yellow blobs.
  float ao = mix(smoothstep(-radius * 0.50, -radius * 0.03, f), 0.55, unres);

  float face = max(dot(vec3(-sign(off), 0.0, 0.0), gSun), 0.0);
  float back = max(dot(rd, gSun), 0.0);
  // Foliage is thin enough that the sky above it reaches well into the mass;
  // the ao term is what keeps the interior from going to a flat silhouette.
  float shade = (0.24 + 0.55 * ao) * (0.35 + 0.90 * form);

  float L = 0.300 + 0.095 * ao + 0.055 * leaf + 0.130 * form + 0.110 * face * shade;
  vec3 albedo = ok(L, 0.080 + 0.022 * face + 0.014 * leaf, hue + 0.012 * leaf);
  vec3 col = albedo * (gSunI * face * shade + gAmb * (0.50 + 0.70 * ao) * (0.6 + 0.5 * form));
  // Backlit rim: leaves at the silhouette edge transmit, which is the whole
  // look of the reference painting's trees against a bright sky.
  // Backlighting, in two parts. Leaves are thin, so a canopy against the sun
  // *transmits* -- that is the warm green glow through the whole mass -- and
  // only the outermost leaves are lit brightly enough to read as a rim. Doing
  // just the rim, as the first pass did, gives a black cut-out with a neon
  // outline; doing just the transmission loses the contre-jour entirely.
  float trans = pow(back, 2.2) * (1.0 - face);
  col += albedo * gSunI * trans * 0.55 * (0.35 + 0.65 * ao);
  col += gSunI * ok(0.88, 0.115, 0.30) * pow(back, 5.0) * pow(ao, 6.0)
         * (0.12 + 0.20 * (1.0 - face));

  col = mix(col, gHaze, 1.0 - exp(-d / hazeDist));
  return vec4(col, cov);
}

// ------------------------------------------------------- height-field layers
//
// Grass, the sea wall and the distant hills are all the same shape of problem:
// a silhouette that is a function of world z alone. Cheaper than the tree SDF
// and enough for anything without a trunk.

float grassTop(float u, float h, float seedOff, float sway) {
  float n1 = 0.5 + 0.5 * snoise(vec2((u + sway) * 1.7, seedOff));
  float n2 = 0.5 + 0.5 * snoise(vec2((u + sway) * 6.1, seedOff + 11.0));
  float n3 = 0.5 + 0.5 * snoise(vec2((u + sway) * 19.0, seedOff + 27.0));
  return h * (0.30 + 0.70 * n1 * n1) * (0.60 + 0.28 * n2 + 0.18 * n3);
}

vec4 grassLayer(float d, float u, float y, float w, float off, float h,
                float seedOff, float hazeDist, vec3 rd) {
  if (d <= 0.0 || y < -0.05) return vec4(0.0);
  // Wind: the tufts lean together in slow gusts travelling along the verge.
  float sway = 0.06 * h * sin(gT * 1.7 + u * 0.55)
               * (0.6 + 0.5 * snoise(vec2(u * 0.08, gT * 0.2)));
  float top = grassTop(u, h, seedOff, sway);
  // Once a blade is under a pixel wide the silhouette has to relax toward the
  // mean height, or the verge fringe crawls with aliasing all the way out.
  top = mix(h * 0.42, top, lodFade(w, 0.10));
  float cov = 1.0 - smoothstep(-w, w, y - top);
  if (cov <= 0.002) return vec4(0.0);

  float face = max(dot(vec3(-sign(off), 0.0, 0.0), gSun), 0.0);
  float tip = clamp(y / max(top, 1e-3), 0.0, 1.0);
  vec3 albedo = ok(0.430 + 0.115 * tip, 0.088 + 0.018 * tip, 0.362 + 0.012 * tip);
  vec3 col = albedo * (gSunI * (0.25 + 0.75 * face) * (0.45 + 0.55 * tip)
                       + gAmb * (0.45 + 0.55 * tip));
  // Seed heads catch the light from behind and go almost white.
  col += gSunI * ok(0.93, 0.075, 0.24) * pow(max(dot(rd, gSun), 0.0), 3.0)
         * pow(tip, 5.0) * 0.16;
  col = mix(col, gHaze, 1.0 - exp(-d / hazeDist));
  return vec4(col, cov);
}

vec4 wallLayer(float d, float u, float y, float w, float hazeDist) {
  if (d <= 0.0 || y < -0.05) return vec4(0.0);
  // A low kerb of set stones at the top of the shingle. Kept under a third of
  // a metre: anything taller and it eats the sea (see the layout note).
  float top = 0.32 + 0.055 * snoise(vec2(u * 0.9, 3.0)) + 0.02 * snoise(vec2(u * 3.1, 9.0));
  float cov = 1.0 - smoothstep(-w, w, y - top);
  if (cov <= 0.002) return vec4(0.0);

  float face = max(dot(vec3(-1.0, 0.0, 0.0), gSun), 0.0);
  // Block joints, faded out once they fall below a pixel.
  float joint = smoothstep(0.04, 0.0, abs(fract(u * 1.4) - 0.5) - 0.46) * lodFade(w, 0.07);
  float grime = 0.5 + 0.5 * fbm(vec2(u * 2.2, y * 5.0), 3) * lodFade(w, 0.14);
  // The top face catches the sky; the front stays in its own shade.
  float cap = smoothstep(top - 0.05, top - 0.012, y);
  vec3 albedo = ok(0.700 + 0.060 * cap - 0.060 * grime - 0.07 * joint, 0.010, 0.19);
  vec3 col = albedo * (gSunI * (0.10 + face * 0.75 + cap * max(gSun.y, 0.0) * 0.75)
                       + gAmb * (1.05 + 0.45 * cap));
  col = mix(col, gHaze, 1.0 - exp(-d / hazeDist));
  return vec4(col, cov);
}

vec4 hillLayer(float d, float u, float y, float w, float height, float seedOff) {
  if (d <= 0.0 || y < 0.0) return vec4(0.0);
  float n1 = 0.5 + 0.5 * fbm(vec2(u * 0.00085, seedOff), 4);
  float n2 = 0.5 + 0.5 * fbm(vec2(u * 0.0042, seedOff + 5.0), 3);
  float top = height * (0.24 + 0.60 * n1 * n1 + 0.26 * n2);
  float cov = 1.0 - smoothstep(-w, w, y - top);
  if (cov <= 0.002) return vec4(0.0);
  // Ridges this far out are pure aerial perspective: a hue and a lightness a
  // little below the haze they sit in, nothing more. Anything more detailed
  // reads as a cardboard cut-out.
  float shade = 0.5 + 0.5 * fbm(vec2(u * 0.006, y * 0.05 + seedOff), 3);
  vec3 col = mix(gHaze * 0.72, gHaze * 0.97, shade);
  col = mix(col, gHaze, 1.0 - exp(-d / 3600.0));
  return vec4(col, cov * 0.92);
}

// -------------------------------------------------------------------- sky

/** Cheap sky, for water reflections where the full version is overkill. */
vec3 skyBase(float upness) {
  return mix(gSkyLo, gSkyHi, pow(clamp(upness, 0.0, 1.0), 0.55));
}

/**
 * Cloud deck on a plane at a fixed altitude.
 *
 * Intersecting a plane rather than painting a dome is what gives the deck
 * perspective: cells crowd together towards the horizon exactly as real clouds
 * do, and the two decks at different altitudes then parallax against each other
 * as the ride advances. A dome would slide rigidly and read as wallpaper.
 *
 * coverage is a threshold on a field centred at 0.5, so values below ~0.4 cover
 * the entire sky. The first pass used 0.02 and produced an unbroken grey smear;
 * the sky needs open blue between the masses far more than it needs cloud.
 */
vec4 clouds(float s, float c, float v, float altitude, float scale,
            float coverage, float sharp, int oct) {
  if (v < 0.003) return vec4(0.0);
  float d = (altitude - gCamH) / v;
  if (d > 120000.0) return vec4(0.0);
  vec2 p = vec2(gCamX + d * s, gCamZ + d * c) * scale;
  // Wind drift, slow enough to read as weather rather than as scrolling.
  p += vec2(0.0175, -0.006) * gT;

  float n = fbm(p, oct) * 0.5 + 0.5;
  // Filter width on the cloud plane, from the same closed-form derivatives.
  float w = (d * gDTheta + (d * d / max(altitude - gCamH, 1.0)) * gDV) * scale;
  // Far cells fall below a pixel: let them relax to the mean rather than fizz.
  n = mix(0.5 + (n - 0.5) * 0.30, n, lodFade(w, 0.5));

  float dens = smoothstep(coverage, coverage + sharp, n);
  if (dens <= 0.003) return vec4(0.0);

  // Lighting by lateral offset toward the sun in the cloud plane: sample the
  // field a little sunward and compare. Cheaper than a normal and it produces
  // the right thing -- bright sunward flanks, heavy shaded bases.
  vec2 sunP = normalize(gSun.xz + vec2(1e-4)) * 0.45;
  float lit = fbm(p + sunP, max(oct - 1, 2)) * 0.5 + 0.5;
  float shade = clamp((lit - n) * 3.2 + 0.52, 0.0, 1.0);

  // Base and lit colour both track the light: at golden hour a cumulus base is
  // slate blue and its sunward flank is apricot, and a fixed pair of greys
  // would flatten exactly the sky the reference is built on.
  vec3 dark = ok(0.500, 0.034, 0.740) * (gAmb * 2.1 + gSunI * 0.10);
  vec3 bright = ok(0.985, 0.016, 0.24) * (gSunI * 0.85 + gAmb * 0.55);
  vec3 col = mix(dark, bright, shade * shade);
  // Silver lining: the thin margin of a cloud transmits, and that is most of
  // the drama in the reference sky.
  float rim = smoothstep(coverage + sharp * 0.9, coverage + sharp * 0.1, n);
  col += gSunI * rim * dens * 0.5 * max(dot(gSun, normalize(vec3(s, v, c))), 0.0);

  col = mix(col, gHaze, 1.0 - exp(-d / 34000.0));
  return vec4(col, dens * 0.97);
}

vec3 skyColor(float s, float c, float v, vec3 rd, out float cloudCover) {
  vec3 col = skyBase(rd.y);

  // Sun: a small disk with a wide forward-scattering halo around it.
  float mu = dot(rd, gSun);
  col += gSunI * (pow(max(mu, 0.0), 8.0) * 0.28 + pow(max(mu, 0.0), 90.0) * 0.85);
  col += gSunI * smoothstep(0.99955, 0.99985, mu) * 18.0;

  // High thin deck first, then the cumulus over it.
  vec4 hi = clouds(s, c, v, 6200.0, 0.00028, 0.54, 0.26, 4);
  col = mix(col, hi.rgb, hi.a * 0.40);
  vec4 lo = clouds(s, c, v, 1500.0, 0.00062, 0.50, 0.15, 5);
  col = mix(col, lo.rgb, lo.a);
  cloudCover = lo.a;

  // Crepuscular rays. Screen-space radial streaks around the sun, gated by the
  // gaps in the low deck so they read as light coming *through* the cloud.
  float sunAz = atan(gSun.x, gSun.z) - gYaw;
  float sunV = gSun.y / max(length(gSun.xz), 1e-3);
  vec2 rel = vec2((atan(s, c) - sunAz) * 0.55, v - sunV);
  float ang = atan(rel.y, rel.x);
  float shaft = fbm(vec2(ang * 3.4, gT * 0.035), 3) * 0.5 + 0.5;
  shaft = smoothstep(0.48, 0.95, shaft) * exp(-length(rel) * 1.9);
  col += gSunI * shaft * 0.35 * (1.0 - cloudCover * 0.8) * smoothstep(-0.04, 0.12, v);

  // Aerial perspective: the last few degrees above the horizon go to haze.
  col = mix(col, gHaze, 1.0 - smoothstep(0.0, 0.085, v));
  return col;
}

// ------------------------------------------------------------------ water

/**
 * Water surface normal from four crossed swells plus chop.
 *
 * Analytic derivatives, so the normal is exact and the specular does not
 * shimmer the way a finite-differenced height field does across this distance
 * range. Amplitude is scaled by the caller's LOD term: past the point where a
 * wavelength is under a pixel the surface flattens to a mirror, which is what
 * real water does at that distance anyway.
 */
vec3 waterNormal(vec2 p, float amp) {
  vec2 g = vec2(0.0);
  vec2 d1 = vec2(0.97, -0.24); float k1 = 0.42;
  vec2 d2 = vec2(0.78, 0.63);  float k2 = 0.71;
  vec2 d3 = vec2(0.99, 0.14);  float k3 = 1.63;
  vec2 d4 = vec2(0.62, -0.79); float k4 = 3.10;
  float ph1 = dot(p, d1) * k1 - gT * 0.95;
  float ph2 = dot(p, d2) * k2 - gT * 1.25;
  float ph3 = dot(p, d3) * k3 - gT * 1.85;
  float ph4 = dot(p, d4) * k4 - gT * 2.60;
  // A slow noise on the chop amplitude breaks the regularity a pure sine sum
  // would otherwise show as a plaid.
  float chop = 0.55 + 0.45 * snoise(p * 0.06 + vec2(0.0, gT * 0.05));
  // Amplitudes are modest on purpose. Seen at the grazing angle a 5:1 frame
  // forces, a steep surface turns into hard horizontal corduroy across the
  // whole bay; the swell has to be readable as crest lines without becoming a
  // barcode.
  float swellMod = 0.55 + 0.45 * snoise(p * 0.018 + vec2(gT * 0.02, 0.0));
  g += 0.026 * k1 * d1 * cos(ph1) * swellMod;
  g += 0.017 * k2 * d2 * cos(ph2);
  g += 0.009 * k3 * d3 * cos(ph3) * chop;
  g += 0.004 * k4 * d4 * cos(ph4) * chop;
  return normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
}

/** Mean waterline offset at world z: a coastline that is not a ruler. */
float shoreLine(float z) {
  return SHORE_X + 0.45 * snoise(vec2(z * 0.016, 4.0)) + 0.16 * snoise(vec2(z * 0.075, 9.0));
}

// ----------------------------------------------------------------- ground

/**
 * Everything below the horizon: tarmac, shoulders, verge, shingle and sea.
 *
 * One plane, shaded by lateral distance from the path centre. The ground is
 * painted before any curtain and never needs to be depth-compared against one,
 * because a curtain is visible exactly where it is nearer than the ground --
 * see the header note.
 */
vec3 groundColor(float d, float s, float c, float v, vec3 rd) {
  float z = gCamZ + d * c;
  float x = gCamX + d * s;
  float lat = x - pathX(z);

  // Closed-form screen footprint on the ground plane. The vertical term goes
  // as d^2 because the plane is being viewed at a grazing angle -- which is why
  // ground detail has to be faded rather than trusted to a sample count.
  float gw = max(d * gDTheta, (d * d / gCamH) * gDV);

  float shore = shoreLine(z);
  vec3 col;

  if (lat < shore) {
    // ---- land -------------------------------------------------------------
    float ar = abs(lat);
    float road = 1.0 - smoothstep(ROAD_HALF - gw * 0.6, ROAD_HALF + gw * 0.6, ar);
    float shoulder = (1.0 - smoothstep(ROAD_HALF + SHOULDER - gw * 0.6,
                                       ROAD_HALF + SHOULDER + gw * 0.6, ar)) - road;

    // Tarmac. Aggregate speckle, worn wheel tracks and hairline cracks; all
    // three are pure motion cue, so they are the details that matter most.
    float grit = fbm(vec2(lat * 26.0, z * 26.0), 3) * lodFade(gw, 0.05);
    float blotch = fbm(vec2(lat * 0.55, z * 0.22), 3);
    // Cracks: contours of a noise field stretched along the direction of
    // travel, so they run with the road rather than doodling loops across it.
    float crackN = snoise(vec2(lat * 2.1, z * 0.09));
    float crack = smoothstep(0.020, 0.0, abs(crackN)) * lodFade(gw, 0.06)
                  * smoothstep(0.15, 0.6, fbm(vec2(z * 0.04, lat * 0.15), 2) * 0.5 + 0.5);
    // Wheel wear: two darker ribbons where tyres actually run, placed by
    // distance from the centre line. An earlier version used a cosine in |lat|,
    // which repeats outward and drew a set of concentric arcs across the road.
    float wear = (1.0 - smoothstep(0.10, 0.34, abs(ar - 0.60))) * 0.035;
    float roadL = 0.505 + 0.040 * grit + 0.035 * blotch - wear - 0.13 * crack;
    vec3 roadC = ok(roadL, 0.009, 0.700);

    // Gravel shoulder: coarser and a touch warmer than the tarmac, but nowhere
    // near as warm as it first was -- a saturated ochre stripe either side of
    // the road pulled the whole frame orange.
    float gv = fbm(vec2(lat * 15.0, z * 15.0), 3) * lodFade(gw, 0.08);
    vec3 shoulderC = ok(0.600 + 0.065 * gv, 0.013, 0.150);

    // Verge and field grass, greener and darker away from the path.
    // Broad tonal patches as well as blade-scale noise: a field of one green
    // over a hundred metres of a 5:1 frame is a large area of nothing.
    float meadow = fbm(vec2(lat * 0.10, z * 0.055), 3);
    float gr = fbm(vec2(lat * 2.2, z * 2.2), 4) + 0.9 * meadow;
    float gr2 = fbm(vec2(lat * 9.0, z * 9.0), 3) * lodFade(gw, 0.12);
    float away = smoothstep(2.5, 26.0, ar);
    vec3 grassC = ok(0.495 + 0.055 * gr + 0.045 * gr2 - 0.080 * away,
                     0.092 + 0.014 * gr, 0.378 - 0.010 * away + 0.012 * meadow);

    // Shingle strip between the wall and the water, damp near the waterline.
    float sandN = fbm(vec2(lat * 4.5, z * 4.5), 3) * lodFade(gw, 0.20);
    float wet = smoothstep(1.6, 0.1, shore - lat);
    vec3 sandC = ok(0.735 + 0.055 * sandN - 0.145 * wet, 0.030 - 0.010 * wet, 0.165);

    col = mix(grassC, shoulderC, shoulder);
    col = mix(col, roadC, road);
    col = mix(col, sandC, smoothstep(WALL_X - 0.35, WALL_X + 0.55, lat));

    // Sunlight, sky fill, and the tree line's shadow across all of it.
    float sh = 1.0;
    if (gSun.x < -0.02) {
      // The tree line is the plane x = pathX(z) + TREE_X. March the sun ray to
      // it and ask whether the canopy is above the hit point.
      float t = (TREE_X - lat) / gSun.x;
      if (t > 0.0 && t < 260.0) {
        float yHit = t * gSun.y;
        float zHit = z + t * gSun.z;
        float top = canopyTop(zHit, TREE_SPACING, TREE_RADIUS, 1.0);
        float pen = 0.10 + 0.075 * t;         // penumbra widens with throw
        float dapple = 0.74 + 0.38 * fbm(vec2(zHit * 0.9, yHit * 0.5), 3);
        sh = 1.0 - 0.78 * smoothstep(yHit - pen, yHit + pen, top * dapple);
        // Past the point where a shadow band is under a pixel, converge on the
        // average rather than strobing.
        sh = mix(sh, 0.64, smoothstep(0.6, 4.0, gw));
      }
    }
    // Contact shade: the ground under and just out from the tree line never
    // sees much sky either, which is what stops the trunks from looking pasted
    // onto a uniformly lit field.
    float amb = 1.0 - 0.42 * exp(-max(lat - TREE_X, 0.0) * 0.30);

    // Softened cosine. The physical term is sin(elevation); compressing it is
    // the surface-side half of the exposure adaptation above, and it is what
    // keeps a low sun reading as warm and raking rather than as simply dark.
    col *= gSunI * mix(0.38, 1.0, max(gSun.y, 0.0)) * sh + gAmb * amb;

    // Grazing sheen. A half-vector lobe on a horizontal plane puts a broad
    // sweep of light down the tarmac when the sun is low ahead -- the single
    // strongest thing in the frame at golden hour, and it costs one pow.
    // Grazing sheen: a half-vector lobe on a horizontal plane. Weak, because
    // tarmac is rough -- the first pass gave it enough weight to wash the near
    // road to white under a high sun, which is where the mirror direction
    // points. Wet shingle at the waterline is the one surface that earns a
    // strong one.
    float sheen = pow(max(dot(normalize(gSun - rd), vec3(0.0, 1.0, 0.0)), 0.0), 34.0);
    col += gSunI * sheen * sh * (0.05 + 0.13 * road + 0.55 * wet);
  } else {
    // ---- water ------------------------------------------------------------
    float amp = lodFade(gw, 2.4);
    vec3 n = waterNormal(vec2(lat, z), amp);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);

    vec3 refl = reflect(rd, n);
    vec3 sky = skyBase(refl.y * 0.5 + 0.5);
    // Glitter. Two lobes: a tight one for individual sparkles near the eye and
    // a broad one that survives the LOD fade and becomes the glare path.
    float sp = max(dot(refl, gSun), 0.0);
    vec3 glint = gSunI * (pow(sp, 900.0) * 30.0 * amp + pow(sp, 40.0) * 1.2);

    // Body colour: turquoise over the shallows, cold blue offshore.
    float depth = smoothstep(0.0, 30.0, lat - shore);
    vec3 body = mix(ok(0.605, 0.085, 0.510), ok(0.430, 0.095, 0.665), depth);
    body *= gSunI * mix(0.30, 1.0, max(gSun.y, 0.0)) * 0.40 + gAmb * 0.60;

    col = mix(body, sky, fres) + glint;

    // Surf. Crests march shoreward; the phase is offset along the coast by a
    // slow noise so the lines are not dead straight, which is the giveaway.
    float outv = lat - shore;
    // Two trains at slightly different speeds and wavelengths, each bent along
    // the coast by its own noise. One train alone lays down parallel corduroy.
    float ph = outv * 0.42 - gT * 0.62 + 0.85 * snoise(vec2(z * 0.02, 1.0));
    float ph2 = outv * 0.29 - gT * 0.47 + 1.20 * snoise(vec2(z * 0.011, 6.0));
    float crest = max(smoothstep(0.66, 0.97, sin(ph * TAU) * 0.5 + 0.5),
                      smoothstep(0.74, 0.99, sin(ph2 * TAU) * 0.5 + 0.5) * 0.75);
    float band = smoothstep(0.2, 1.6, outv) * (1.0 - smoothstep(4.0, 14.0, outv));
    float foam = crest * band * lodFade(gw, 1.6);
    // Swash: the thin ragged edge where the water meets the shingle.
    float swash = (1.0 - smoothstep(0.0, 1.1 + 0.5 * snoise(vec2(z * 0.35, gT * 0.3)), outv))
                  * (0.55 + 0.45 * fbm(vec2(z * 2.0, gT * 0.5), 2));
    float foamT = clamp(foam + swash * 0.9, 0.0, 1.0)
                  * (0.55 + 0.45 * fbm(vec2(z * 3.0, outv * 3.0), 3));
    col = mix(col, ok(0.99, 0.008, 0.62) * (gSunI * 0.55 + gAmb * 0.75),
              clamp(foamT, 0.0, 1.0));
  }

  // Aerial perspective. The ground haze distance is shorter than the sky's:
  // looking along the surface there is more air in the way per metre.
  col = mix(col, gHaze, 1.0 - exp(-d / 1500.0));
  return col;
}

// ------------------------------------------------------------- handlebars
//
// Composed in a screen space measured in frame heights, with the origin at the
// bottom centre, so the assembly keeps its proportions at any aspect ratio: on
// 16:9 it fills more of the width, on 5:1 less, and in both cases it reads as
// the same bike.

float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdEllipse(vec2 p, vec2 c, vec2 r, float rot) {
  vec2 q = p - c;
  float cs = cos(rot), sn = sin(rot);
  q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  // Scaled circle rather than a true ellipse SDF; the anisotropy here is mild
  // and the exact distance is only used for a 5px antialias band.
  return (length(q / r) - 1.0) * min(r.x, r.y);
}

/** Height of the bar's centre line at horizontal position hx. */
float barLine(float hx, float rise) {
  return 0.100 + rise * hx * hx;
}

const float BAR_RISE = 0.028;  // gentle riser sweep
const float BAR_R    = 0.019;  // tube radius

/**
 * Bar half-width in frame heights.
 *
 * Not a constant, because the assembly is measured in frame *heights* while the
 * frame it has to sit inside is measured in widths. A fixed 1.02 puts the grips
 * 12% outside a 16:9 frame while covering a sensible 41% of a 5:1 one. Tying it
 * to the aspect ratio keeps the bars filling roughly the same fraction of the
 * width everywhere, which is what actually reads as "the same bike".
 */
float barHalf() {
  return clamp(0.30 * iResolution.x / iResolution.y, 0.50, 1.05);
}

/** Centre of one hand on the bar, and the bar height there. */
vec2 handCentre(float sgn, float bh) {
  float hx = sgn * (bh - 0.150);
  return vec2(hx, barLine(hx, BAR_RISE) + 0.020);
}

/**
 * One hand as a signed distance field: the back of the hand over the bar, four
 * fingers curling in front of the tube, a thumb tucked under, and a forearm
 * running off the bottom of the frame.
 *
 * The finger capsules are placed by index rather than min'd from a blob,
 * because handColor() needs to know *which* finger a pixel is on to shade the
 * creases between them -- an SDF union throws that away, and without the
 * creases four adjacent capsules read as one mitten.
 */
float handField(vec2 p, float sgn, float bh) {
  vec2 h = handCentre(sgn, bh);
  // Back of the hand: wider than tall, tipped slightly outboard.
  float back = sdEllipse(p, h + vec2(sgn * 0.010, 0.012), vec2(0.112, 0.055), sgn * 0.13);
  float fingers = 1e6;
  for (int i = 0; i < 4; i++) {
    float t = float(i) - 1.5;
    // Index finger sits highest and the little finger lowest, and the whole
    // set curls inboard as it comes down over the tube.
    float fx = h.x - sgn * t * 0.050;
    float top = h.y + 0.030 - abs(t + 0.35) * 0.008;
    fingers = min(fingers, sdSeg(p, vec2(fx, top),
                                 vec2(fx + sgn * 0.014, h.y - 0.052), 0.0225));
  }
  // Thumb inboard, toward the stem, tucked slightly under the bar.
  float thumb = sdSeg(p, vec2(h.x - sgn * 0.062, h.y - 0.004),
                      vec2(h.x - sgn * 0.140, h.y - 0.034), 0.020);
  // Forearm, tapering and steep enough to leave the frame rather than lying
  // across it as a slab. Two segments give it a bend at the wrist.
  float arm = min(sdSeg(p, vec2(h.x - sgn * 0.02, h.y - 0.030),
                        vec2(h.x - sgn * 0.11, h.y - 0.145), 0.040),
                  sdSeg(p, vec2(h.x - sgn * 0.11, h.y - 0.145),
                        vec2(h.x - sgn * 0.22, -0.24), 0.048));
  return min(min(back, fingers), min(thumb, arm));
}

/** Shading for one hand. See handField for why the fingers are indexed. */
vec3 handColor(vec2 p, float sgn, float bh, vec3 key) {
  vec2 h = handCentre(sgn, bh);

  // Which finger, and how far across it. The creases between fingers and the
  // highlight along each knuckle both come from this one coordinate.
  float fu = (h.x - p.x) * sgn / 0.050 + 1.5;
  float acrossF = fract(fu + 0.5) - 0.5;
  float inFingers = smoothstep(0.014, 0.030, h.y + 0.034 - p.y)
                    * (1.0 - smoothstep(0.055, 0.075, h.y - p.y))
                    * (1.0 - smoothstep(1.9, 2.4, abs(fu - 1.5)));
  float crease = smoothstep(0.26, 0.50, abs(acrossF)) * inFingers * 0.8;
  float knuckle = (1.0 - smoothstep(0.0, 0.26, abs(acrossF))) * inFingers;

  // Top light from the sky, shadow underneath, and a warm bounce off the road,
  // which is what stops the hands reading as grey-mauve against a cool scene.
  float up = smoothstep(h.y - 0.075, h.y + 0.055, p.y);
  float under = smoothstep(h.y - 0.02, h.y - 0.18, p.y);
  float L = 0.610 + 0.085 * up + 0.045 * knuckle - 0.135 * crease - 0.130 * under;
  // Hue 0.145 turns, not 0.048. In OKLab the +a axis is magenta, and skin sits
  // between +a and +b at roughly a=0.04, b=0.06 -- a hue near zero renders the
  // hands bubblegum pink, which is where the first two attempts landed.
  vec3 skin = ok(L, 0.055 + 0.014 * crease + 0.008 * under, 0.145);
  vec3 col = skin * (key + gSunI * 0.10 * (1.0 - up));
  // Rim along the top edge of the hand, where it catches the sky directly.
  col += gSkyHi * pow(up, 9.0) * 0.20;
  return col;
}

/**
 * The rider's hands and bars, plus the idle movement that keeps them alive.
 *
 * Three motions, all at cadence-related rates rather than arbitrary ones:
 *  - a lateral rock at pedalling cadence, as the rider's weight alternates,
 *  - a vertical bob at twice cadence, once per pedal stroke,
 *  - a slow steering correction that shears the bar in depth, so the near grip
 *    rides a little higher than the far one.
 * The bike leans into bends and the camera leans with it, so on a curve the
 * *horizon* tilts while the bar stays level. That is the correct relationship
 * and it is worth more than any amount of extra bar wobble.
 *
 * Returns rgb + alpha; the alpha is the assembly's own coverage, extended
 * outward into a soft contact shadow so the silhouette separates from whatever
 * road, grass or water happens to be behind it.
 */
vec4 handlebars(vec2 hp, float steer) {
  float bh = barHalf();
  float rock = sin(gT * TAU * CADENCE);
  float bob = sin(gT * TAU * CADENCE * 2.0 + 0.9);
  vec2 p = hp;
  p.x -= 0.012 * rock + 0.018 * steer;
  p.y -= 0.0070 * bob + 0.0035 * sin(gT * 0.37);
  // Steering shear: rotating the bar about the steerer tips one end toward the
  // viewer, which in projection lifts it slightly.
  p.y -= steer * p.x * 0.070;

  float by = barLine(p.x, BAR_RISE);

  // --- component distances --------------------------------------------------
  float stem = min(sdSeg(p, vec2(0.0, -0.12), vec2(0.0, by - 0.002), 0.026),
                   sdSeg(p, vec2(-0.048, by), vec2(0.048, by), 0.023));

  float bar = max(abs(p.y - by) - BAR_R, abs(p.x) - bh);

  float grip = 1e6, lever = 1e6, skin = 1e6;
  for (float sgn = -1.0; sgn <= 1.0; sgn += 2.0) {
    float gIn = sgn * (bh - 0.30);
    float gy = barLine(sgn * bh, BAR_RISE), gy0 = barLine(gIn, BAR_RISE);
    grip = min(grip, sdSeg(p, vec2(gIn, gy0), vec2(sgn * bh, gy), 0.026));
    lever = min(lever, sdSeg(p, vec2(gIn - sgn * 0.010, gy0 - 0.006),
                             vec2(gIn - sgn * 0.090, gy0 - 0.044), 0.0085));
    skin = min(skin, handField(p, sgn, bh));
  }

  float all = min(min(min(stem, bar), min(grip, lever)), skin);
  if (all > 0.02) return vec4(0.0);

  // A foreground object this close gets no aerial perspective at all, so it
  // stays the highest-contrast thing in the frame -- which is what lets it
  // anchor the composition rather than floating in it.
  vec3 key = gSunI * 0.30 * max(gSun.y, 0.15) + gAmb * 0.95;
  float aa = 0.0032;

  // Contact edge first: a narrow dark rim just outside the silhouette, so the
  // bar separates from a road, a verge or a stretch of water equally well.
  vec4 outc = vec4(vec3(0.0), (1.0 - smoothstep(0.0, 0.012, all)) * 0.30);

  outc = mix(outc, vec4(ok(0.44, 0.010, 0.62) * key, 1.0),
             1.0 - smoothstep(0.0, aa, stem));

  // Brushed aluminium: a hard specular line along the upper third and a dark
  // underside, which is all it takes for a flat SDF to read as a tube.
  float across = clamp((p.y - by) / BAR_R, -1.0, 1.0);
  vec3 barC = ok(0.585 + 0.155 * across, 0.008, 0.66) * key
              + gSkyHi * smoothstep(0.20, 0.80, across) * smoothstep(1.0, 0.68, across) * 2.2;
  outc = mix(outc, vec4(barC, 1.0), 1.0 - smoothstep(0.0, aa, bar));

  outc = mix(outc, vec4(ok(0.40, 0.008, 0.62) * key, 1.0),
             1.0 - smoothstep(0.0, aa, lever));

  float gAcross = clamp((p.y - by - 0.004) / 0.026, -1.0, 1.0);
  vec3 gripC = ok(0.285 + 0.080 * gAcross, 0.007, 0.10) * key
               + gSkyHi * smoothstep(0.45, 0.95, gAcross) * 0.22;
  outc = mix(outc, vec4(gripC, 1.0), 1.0 - smoothstep(0.0, aa, grip));

  // Hands last, over the bar and the grips -- fingers wrap in front of the tube.
  for (float sgn = -1.0; sgn <= 1.0; sgn += 2.0) {
    float sk = handField(p, sgn, bh);
    float a = 1.0 - smoothstep(0.0, aa, sk);
    if (a > 0.002) outc = mix(outc, vec4(handColor(p, sgn, bh, key), 1.0), a);
  }
  return outc;
}

// -------------------------------------------------------------------- main

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;

  // ---- per-activation variation -------------------------------------------
  // iSeed gives four decorrelated randoms; the hash library extends them where
  // more are wanted, so nothing here is a function of iTime alone.
  gP1 = iSeed.y * TAU;
  gP2 = iSeed.z * TAU;
  float flip = iSeed.w < 0.5 ? -1.0 : 1.0;   // which side the sea is on
  float startZ = rand(vec2(iSeed.x, iSeed.y)) * 9000.0;

  gT = iTime + iSeed.z * 240.0;
  gCamZ = startZ + gT * SPEED;

  // ---- time of day ---------------------------------------------------------
  // Elevation never goes below ~13 degrees. This is the no-signal display in a
  // lit room: a night scene would be a black wall, which is a failure mode
  // rather than a mood. The azimuth sweeps right across the sky, so the same
  // ride is front-lit, overhead-lit and backlit at different points in the arc.
  float day = fract(iSeed.x + gT / TOD_PERIOD);
  float elev = mix(0.225, 1.02, 0.5 - 0.5 * cos(day * TAU));
  // Azimuth sweeps east-to-west while elevation peaks in the middle, which is
  // what a real sun does -- and which means a low sun is always well off to one
  // side. The offset is the direction the *path* happens to run, drawn per
  // activation: without it the contre-jour case (a low sun straight down the
  // road, glare on the tarmac, the tree line reduced to silhouette) could never
  // occur, because it requires a road pointing at the sunset.
  float heading = (rand(vec2(iSeed.w, 3.0)) - 0.5) * 2.4;
  float sunAz = mix(-1.25, 1.32, day) + heading;
  gSun = vec3(sin(sunAz) * cos(elev), sin(elev), cos(sunAz) * cos(elev));

  float low = 1.0 - smoothstep(0.20, 0.72, elev);
  vec3 sunCol = mix(ok(1.00, 0.018, 0.22), ok(0.97, 0.098, 0.135), low);
  gSkyHi = ok(mix(0.690, 0.600, low), mix(0.125, 0.095, low), mix(0.730, 0.752, low));
  gSkyLo = ok(mix(0.870, 0.860, low), mix(0.040, 0.100, low), mix(0.665, 0.145, low));
  gHaze = ok(mix(0.800, 0.790, low), mix(0.028, 0.062, low), mix(0.665, 0.150, low));

  // Exposure adaptation, as a constant key and fill.
  //
  // Direct sun on a horizontal surface falls off as sin(elevation), so a
  // physically-scaled golden-hour ground is four times darker than a noon one,
  // and rendering that faithfully just produces an underexposed frame. An eye
  // or a camera would open up, so this does too: the *colour* of the key and
  // the fill tracks the sun, their *level* does not.
  //
  // The fill is weighted heavily toward the zenith rather than the horizon
  // band. That is both physically right -- the dome is what lights a shaded
  // surface, not the 5 degrees above the sea -- and the fix for the failure
  // mode of the first pass, where a sunset horizon at full weight tinted every
  // surface in the frame the same salmon pink.
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  vec3 ambCol = gSkyHi * 0.80 + gSkyLo * 0.20;
  // Pull a third of the fill's chroma out. A hemisphere integrates a whole
  // sky, not one direction of it, so a fill carrying the zenith's full
  // saturation tints every shadow in the frame violet.
  ambCol = mix(ambCol, vec3(dot(ambCol, vec3(0.2126, 0.7152, 0.0722))), 0.34);
  gSunI = sunCol * (0.78 / max(dot(sunCol, LUMA), 1e-3));
  gAmb = ambCol * (0.205 / max(dot(ambCol, LUMA), 1e-3));

  // ---- camera --------------------------------------------------------------
  gCamX = pathX(gCamZ);
  gYaw = atan(pathSlope(gCamZ));
  // Pedalling bob: a couple of centimetres at twice cadence, plus a slower
  // breathing rise. Small numbers, but on a 10m wall the horizon moving at all
  // is the difference between riding and sliding.
  gCamH = EYE_H + 0.021 * sin(gT * TAU * CADENCE * 2.0) + 0.010 * sin(gT * 0.41);

  // Lean into the bend, from the path's curvature. See ROLL_GAIN.
  float lean = atan(SPEED * SPEED * pathCurve(gCamZ) / 9.81);
  float roll = clamp(-lean * ROLL_GAIN, -ROLL_MAX, ROLL_MAX)
               + 0.0022 * sin(gT * TAU * CADENCE + 0.6);
  float steer = clamp(pathSlope(gCamZ) * 1.6, -1.0, 1.0) * 0.35
                + 0.30 * sin(gT * 0.23 + iSeed.y * 6.0);

  // ---- projection ----------------------------------------------------------
  vec2 hp = vec2((fragCoord.x - 0.5 * res.x) / res.y, fragCoord.y / res.y);

  // Roll about the frame centre, in aspect-correct units so the rotation is a
  // rotation and not a shear.
  vec2 rp = vec2(hp.x, hp.y - 0.5);
  float cr = cos(roll), sr = sin(roll);
  rp = vec2(rp.x * cr - rp.y * sr, rp.x * sr + rp.y * cr);

  // Pitch bob shifts the horizon a little out of phase with the height bob, so
  // the two do not lock into one rigid motion.
  float pitch = 0.0055 * sin(gT * TAU * CADENCE * 2.0 + 1.9);
  float theta = rp.x * (res.y / res.x) * HFOV * flip;
  float v = (rp.y + 0.5 - HORIZON + pitch) * VSPAN;

  gDTheta = HFOV / res.x;
  gDV = VSPAN / res.y;

  float thetaW = theta + gYaw;
  float s = sin(thetaW), c = cos(thetaW);
  vec3 rd = normalize(vec3(s, v, c));

  // ---- sky, then ground, then curtains far to near -------------------------
  float cloudCover = 0.0;
  vec3 col = skyColor(s, c, v, rd, cloudCover);

  if (v < -1e-4) col = groundColor(gCamH / (-v), s, c, v, rd);

  // Each curtain: invert to a distance, convert to world (z-along, height),
  // shade, composite. A layer on the wrong side of the path returns d < 0 and
  // costs one comparison.
  float vanish = curtainFade(s);
  float d;

  d = curtainDist(s, c, HILL_R);
  if (d > 0.0) {
    vec4 L = hillLayer(d, gCamZ + d * c, gCamH + d * v,
                       flatWidth(curtainWidth(d, v, s, c), 40.0), 200.0, 17.0);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, HILL_L);
  if (d > 0.0) {
    vec4 L = hillLayer(d, gCamZ + d * c, gCamH + d * v,
                       flatWidth(curtainWidth(d, v, s, c), 40.0), 165.0, 31.0);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, FARTREE_X);
  if (d > 0.0) {
    vec4 L = treeLayer(d, gCamZ + d * c, gCamH + d * v,
                       curtainWidth(d, v, s, c), FARTREE_X, 5.0,
                       24.0, 7.5, 0.398, 1100.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, MIDTREE_X);
  if (d > 0.0) {
    vec4 L = treeLayer(d, gCamZ + d * c, gCamH + d * v,
                       curtainWidth(d, v, s, c), MIDTREE_X, 3.0,
                       17.0, 5.2, 0.388, 700.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, TREE_X);
  if (d > 0.0) {
    vec4 L = treeLayer(d, gCamZ + d * c, gCamH + d * v,
                       curtainWidth(d, v, s, c), TREE_X, 1.0,
                       TREE_SPACING, TREE_RADIUS, 0.378, 520.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, WALL_X);
  if (d > 0.0) {
    vec4 L = wallLayer(d, gCamZ + d * c, gCamH + d * v,
                       flatWidth(curtainWidth(d, v, s, c), 0.14), 420.0);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, HEDGE_X);
  if (d > 0.0) {
    // Scrub, as the same tree machinery at a tenth the scale. Without it the
    // trunks meet the field on a bare line and the whole row reads as pasted
    // onto the grass.
    vec4 L = treeLayer(d, gCamZ + d * c, gCamH + d * v,
                       curtainWidth(d, v, s, c), HEDGE_X, 9.0,
                       3.1, 1.05, 0.368, 460.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, VERGE_R);
  if (d > 0.0) {
    vec4 L = grassLayer(d, gCamZ + d * c, gCamH + d * v,
                        flatWidth(curtainWidth(d, v, s, c), 0.20), VERGE_R, 0.26, 41.0, 400.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }
  d = curtainDist(s, c, VERGE_L);
  if (d > 0.0) {
    vec4 L = grassLayer(d, gCamZ + d * c, gCamH + d * v,
                        flatWidth(curtainWidth(d, v, s, c), 0.28), VERGE_L, 0.44, 13.0, 400.0, rd);
    col = mix(col, L.rgb, L.a * vanish);
  }

  // ---- foreground ----------------------------------------------------------
  vec4 bars = handlebars(hp, steer);
  col = mix(col, bars.rgb, bars.a);

  // Linear HDR out. The post chain owns tonemap, gamma and dither; doing any of
  // it here would double-apply them (issue #140) and would also squash the
  // signal the bloom threshold is measured against.
  fragColor = vec4(col, 1.0);
}
`

// No supersampling. Every edge here is cut with an analytic screen-space filter
// width (see the ANTI-ALIASING note in the header), which handles the vanishing
// point better than any fixed sample count could -- and this shader is already
// the most expensive fragment in the set, so 2x samples would be paid twice
// over for a worse result.
export default createShaderScreensaver('Bicycle Horizon', SHADER, {
  // Threshold above 1.0 on purpose: this is a bright scene whose *diffuse*
  // values sit around 0.2-0.9 linear, and only the things that should glow --
  // the sun disk, lit cloud margins, water glitter and the specular line on the
  // bar -- are written past 1.0. A sub-1.0 threshold would bloom the sky itself
  // and turn the whole frame to fog.
  postFX: {
    bloom: { threshold: 1.15, knee: 0.45, intensity: 0.45, radius: 1.05 },
    // Exposure a touch under 1: the scene is deliberately keyed bright, and
    // ACES rolls the sky off gracefully, but the sunlit tarmac was landing
    // close enough to white to lose its texture.
    exposure: 0.93
  }
})
