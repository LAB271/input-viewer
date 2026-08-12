// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Truchet Tiles -- a multi-scale woven knot on a randomly subdivided lattice
 * (#93, rebuilt for #180).
 *
 * The first version was a single square grid of quarter arcs: correct, and
 * completely flat. Every cell was the same size and the same weight across all
 * 6000px, the palette was pastel-on-pastel, and the arcs never crossed, so the
 * frame read as wallpaper with no focal point. This version keeps the arc SDF
 * and its fwidth anti-aliasing -- those were right -- and rebuilds everything
 * around them.
 *
 * WHAT MAKES IT MULTI-SCALE
 *
 * The lattice is a quadtree. A macro cell is MACRO_CELLS fine cells across and
 * may subdivide twice, so three tile sizes coexist: 4x4, 2x2 and 1x1 fine
 * cells. The connection points ("ports") always sit at the centres of the
 * *fine* cell edges, at every level. A coarse tile therefore carries a bundle
 * of n = 4 parallel cords per edge, a 2x2 tile two, and a 1x1 tile one.
 *
 * That is the whole trick, and it is why the scales can meet at all. The
 * obvious quadtree -- one cord per edge whatever the level -- puts a coarse
 * tile's port at the midpoint of an edge that its subdivided neighbour has cut
 * in four, so every scale boundary is a row of dead ends. Bundling instead
 * keeps the port lattice uniform, so a coarse tile's four cords land exactly on
 * the four cords of the fine tiles opposite. Cord width is constant across all
 * three scales, so the result reads as one cord system at three densities
 * rather than three unrelated patterns. It is Carlson's multi-scale Truchet
 * construction (Bridges 2018) reduced to what a fragment shader needs.
 *
 * A coarse bundle is not more expensive than a single cord: within a corner
 * bundle the radii are (k + 0.5) fine cells, so the nearest arc is
 * floor(length) + 0.5 and the distance to the whole bundle is one clamp and one
 * abs -- constant time whatever n is.
 *
 * WHAT MAKES IT WEAVE
 *
 * Two tile families share the same ports: the arc tile (two corner bundles) and
 * the crossing tile (n vertical bands over/under n horizontal bands). The
 * crossing tile alternates which band is on top per fine cell, so a cord goes
 * over, under, over along its length -- the alternating knot condition, which
 * is what the eye reads as woven rather than stacked. The strand underneath
 * takes a contact shadow from the one above, and the whole weave drops a soft
 * shadow onto the ground.
 *
 * WHAT MAKES THE PATHS VISIBLE
 *
 * Connectivity is not derivable in closed form from a hash, so the tiling is
 * generated on the CPU and a union-find over the ports gives every connected
 * path an identity. Hue comes from the path's lowest port index (stable across
 * merges: absorbing a small loop into a large path keeps the large path's hue)
 * and lightness from log(path length), so the small closed loops come out
 * bright and saturated against the mid-tone of the giant percolating path. Two
 * small textures carry the result to the shader: uTile (the quadtree) and uPath
 * (per-port hue and length). Path colours are eased toward their targets over
 * ~0.7s so a retiling merges colours rather than snapping them.
 *
 * WHAT MOVES
 *
 * Retiling travels: a tile's beat phase is time plus a projection of its
 * position onto a per-activation direction, so the swap sweeps across the wall
 * as a front instead of every cell flipping on its own clock.
 *
 * A tile retiles by ROTATING a quarter turn. That works because a 90-degree turn
 * about the tile centre maps SW->SE, SE->NE, NE->NW, NW->SW, carrying the even
 * layout's corner pair {SW, NE} exactly onto the odd layout's {SE, NW}: the two
 * layouts are a quarter turn apart.
 *
 * An earlier revision crossfaded the two layouts instead, on the grounds that the
 * strand at a given port changes partner so no continuous deformation connects
 * them. That is true of interpolating the PAIRING, but the rotation sidesteps it
 * by moving the whole tile. What genuinely cannot be continuous is the path
 * colour -- a retiling really does re-wire which strand belongs to which path --
 * so ports snap at the half-way point, where the arcs sit at 45 degrees to the
 * edges and the geometry is furthest from any valid tiling. COLOUR_EASE then
 * spreads that snap over ~0.7s.
 *
 * The rotation is preferred because a crossfade reads as one image dissolving
 * into another, while a turn reads as the tile itself moving -- and the tile is
 * the object the eye is tracking.
 *
 * On top of that the key light drifts across the frame over minutes, which is
 * what gives the eye somewhere to land at 5:1.
 */
import { createGLRuntime, luminanceScale } from './gl-base.js'
import { GLSL, canvasAspect, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// Fine cells per macro-cell edge. 4 = three tile scales (4x4, 2x2, 1x1). Eight
// would add a fourth, but a 16-cord bundle at wall scale is a solid disc of
// cord rather than a legible bundle, and the coarse tiles already carry the
// composition at 4.
const MAX_LEVEL = 2
const MACRO_CELLS = 1 << MAX_LEVEL

// Seconds for a path's colour to reach its target after a retiling changes the
// connectivity. Long enough that a merge reads as a flood rather than a cut,
// short enough that it has settled before the next front arrives.
const COLOUR_EASE = 0.7

// Minimum gap between union-find rebuilds. The rebuild is well under a
// millisecond at this grid size, but there is no point running it at 60Hz when
// tile flips are seconds apart.
const REBUILD_INTERVAL = 0.1

const SHADER = /* glsl */`#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D uTile;   // per fine cell: r = quadtree level, g = tile family, b = beat phase
uniform sampler2D uPath;   // per port: horizontal edge in .rg, vertical edge in .ba (hue, length)
uniform vec2 uGrid;        // fine-grid size, in cells
uniform float uCell;       // world units per fine cell
uniform float uTheta;      // lattice rotation, radians
uniform float uZoom;       // slow breathing of the lattice
uniform float uWidth;      // cord half width, in fine cells
uniform vec3 uWave;        // xy = retile front direction, z = turns per fine cell
uniform vec2 uBeat;        // x = flips per second, y = per-tile phase spread
uniform vec2 uFocus;       // key-light centre, world space
uniform vec4 uLight;       // ambient, key gain, sweep gain, sweep centre x
uniform vec3 uInk;         // hue base, hue span, chroma
uniform vec2 uGroundOff;   // per-activation offset into the ground noise field
uniform float uLum;
out vec4 outColor;

${GLSL.simplex2d}
${GLSL.fbm}
${GLSL.palette}
${GLSL.worldSpace}

const int MACRO = ${MACRO_CELLS};

// Fraction of a beat the turn occupies. The retiling front is a spatial phase
// gradient, so this window is also the WIDTH of the disturbed band on the wall:
// at 0.40..0.60 a fifth of the frame was mid-turn at once and the whole stripe
// read as broken cord. Narrow and centred keeps the turn a local event.
const float TURN_IN = 0.46;
const float TURN_OUT = 0.54;

// One cord layer at this pixel. Two of these describe any tile: the strand
// nearest the eye and the one behind it.
struct Strand {
  float d;      // distance to the centreline, in fine cells
  float w;      // half width, in fine cells
  float a;      // opacity, < 1 only while this pair is being retiled out
  ivec2 port;   // the port texel that identifies the strand's path
  int axis;     // 0 = port on a horizontal edge (.rg), 1 = vertical (.ba)
};

// Cord half width for this fragment; set once in main from the weight field so
// every tileAt() call in the frame agrees on it.
float gWidth;

// Rotation taking world space into lattice space.
mat2 latRot() {
  float c = cos(uTheta), s = sin(uTheta);
  return mat2(c, -s, s, c);
}

// Distance to the nearest arc of a corner bundle, and that arc's index.
//
// The bundle is n concentric quarter arcs centred on a tile corner, at radii
// 0.5, 1.5, ... n-0.5 fine cells -- exactly the fine-edge midpoints, which is
// what lets a coarse tile meet subdivided neighbours. Evenly spaced radii mean
// the nearest one is floor(L) + 0.5 with no search. No angular clamp is needed
// either: a point inside the tile is always inside the corner's quadrant, so
// the quarter arc is the whole circle as far as this point is concerned.
vec2 bundle(float L, float fn) {
  float k = clamp(floor(L), 0.0, fn - 1.0);
  return vec2(abs(L - (k + 0.5)), k);
}

// Resolve the tile covering a lattice position and the two cord layers there.
bool tileAt(vec2 f, out Strand top, out Strand bot) {
  top = Strand(1e6, 1.0, 0.0, ivec2(0), 0);
  bot = top;
  ivec2 ci = ivec2(floor(f));
  if (ci.x < 0 || ci.y < 0 || ci.x >= int(uGrid.x) || ci.y >= int(uGrid.y)) return false;

  vec4 t = texelFetch(uTile, ci, 0);
  // The quadtree is aligned, so the leaf origin follows from its level alone
  // and only the level has to be stored per fine cell.
  int level = int(t.r * 255.0 + 0.5);
  int n = MACRO >> level;
  ivec2 o = (ci / n) * n;
  float fn = float(n);
  vec2 q = f - vec2(o);
  int m = int(floor(q.x));
  int r = int(floor(q.y));

  if (t.g > 0.5) {
    // Crossing tile: n vertical bands on x = m + 0.5 and n horizontal bands on
    // y = r + 0.5, so the distance to each family is exact and costs one fract.
    Strand sv = Strand(abs(fract(q.x) - 0.5), gWidth, 1.0, ivec2(o.x + m, o.y), 0);
    Strand sh = Strand(abs(fract(q.y) - 0.5), gWidth, 1.0, ivec2(o.x, o.y + r), 1);
    // Alternate the crossing order per fine cell, offset by the tile's own
    // parity so neighbouring tiles do not line up. Alternating is the whole
    // point: a cord that is always on top is a ribbon lying on a pile, and a
    // cord that alternates is woven.
    float par = mod(float(m + r + o.x / n + o.y / n), 2.0);
    if (par < 0.5) { top = sv; bot = sh; } else { top = sh; bot = sv; }
    return true;
  }

  // Arc tile. The beat phase carries the retiling front: time, plus the tile's
  // position projected on the front direction, plus a per-tile offset so the
  // front is ragged rather than a ruled line.
  float phi = uBeat.x * iTime + dot(vec2(o) + fn * 0.5, uWave.xy) * uWave.z + t.b * uBeat.y;
  float tau = fract(phi);

  // A tile retiles by ROTATING a quarter turn, not by crossfading two layouts.
  //
  // A 90-degree turn about the tile centre maps SW->SE, SE->NE, NE->NW, NW->SW,
  // so it carries the even layout's corner pair {SW, NE} exactly onto the odd
  // layout's {SE, NW}. The two layouts *are* a quarter turn apart, which is why
  // rotating works at all -- the same fact the pre-bundle version relied on.
  //
  // The ease keeps the front's cadence: smoothstep(0.40, 0.60) spends 80% of the
  // beat held at a quarter-turn multiple and 20% turning, so a tile still holds a
  // layout for 12-22 seconds and then moves, rather than spinning continuously.
  //
  // mod 4 wraps the angle without a visible seam: four quarter turns is a full
  // revolution, and the port parity below is 2-periodic, so both agree at the
  // wrap. It keeps ang small over a 10-minute rotation slot.
  float turns = mod(floor(phi) + smoothstep(TURN_IN, TURN_OUT, tau), 4.0);
  float ang = turns * 1.5707963;

  // Rotating the sample point by +ang renders the content rotated by -ang. The
  // rotated point can leave the tile square near the tile's own corners; that is
  // correct and self-limiting rather than an artifact, because bundle() clamps
  // the radius index, so beyond the outermost arc the distance grows and no cord
  // is drawn. The pattern is simply clipped to the tile, like a square window
  // onto a turning disc.
  vec2 tc = vec2(fn * 0.5);
  float cs = cos(ang), sn = sin(ang);
  vec2 qr = tc + mat2(cs, -sn, sn, cs) * (q - tc);

  vec2 bsw = bundle(length(qr), fn);
  vec2 bne = bundle(length(qr - vec2(fn)), fn);

  // Ports follow the NEAREST quarter turn, not the continuous angle. A retiling
  // genuinely re-wires which strand belongs to which path, so path colour cannot
  // follow the rotation continuously -- there is no correct intermediate. Nearest
  // puts the change at tau = 0.5, where the arcs sit at 45 degrees to the tile
  // edges and the geometry is furthest from any valid tiling, so the hue change
  // reads as part of the turn instead of as a separate event.
  //
  // Each bundle is identified by the horizontal edge it terminates on; the column
  // depends on which side of the tile the corner is, because the radius index
  // counts outward from it. At an odd quarter turn the pair has landed on the
  // other diagonal, so the two bundles exchange which edge they belong to.
  bool oddTurn = mod(floor(turns + 0.5), 2.0) >= 0.5;
  Strand a, b;
  if (oddTurn) {
    a = Strand(bsw.x, gWidth, 1.0, ivec2(o.x + n - 1 - int(bsw.y), o.y), 0);
    if (bne.x < bsw.x) a = Strand(bne.x, gWidth, 1.0, ivec2(o.x + int(bne.y), o.y + n), 0);
  } else {
    a = Strand(bsw.x, gWidth, 1.0, ivec2(o.x + int(bsw.y), o.y), 0);
    if (bne.x < bsw.x) a = Strand(bne.x, gWidth, 1.0, ivec2(o.x + n - 1 - int(bne.y), o.y + n), 0);
  }

  // THE TILE UNTIES BEFORE IT TURNS.
  //
  // A quarter turn maps the S edge onto the E edge, so a bundle's endpoints do
  // not slide along their edge -- they leave it. There is no version of this
  // rotation where they stay joined to the neighbour, and a plain rotation looks
  // it: measured at 1200x240, mid-turn tiles showed cords chopped flat against a
  // visible tile boundary, four cords wide on a coarse tile. It read as tearing.
  //
  // So the cords retract from the boundary while the tile turns and re-extend
  // once it lands. Width and coverage are pinched toward zero within about half a
  // fine cell of the tile edge, in proportion to how far through the turn the tile
  // is. The break still happens -- it has to -- but it happens at a free end
  // moving inward rather than at a butt joint, which is what "unties and reties"
  // actually looks like.
  //
  // Both terms are needed: pinching width alone leaves a hairline where the
  // antialias band straddles w = 0.
  float turning = 1.0 - abs(2.0 * clamp((tau - TURN_IN) / (TURN_OUT - TURN_IN), 0.0, 1.0) - 1.0);
  vec2 dEdge2 = min(q, vec2(fn) - q);
  float dEdge = min(dEdge2.x, dEdge2.y);
  a.w = gWidth * mix(1.0, smoothstep(0.0, 0.55, dEdge), turning);
  a.a = mix(1.0, smoothstep(0.0, 0.35, dEdge), turning);

  // An arc tile carries one bundle pair, so there is no second layer to weave
  // against -- unlike a crossing tile, which alternates. bot stays empty.
  b = Strand(1e6, gWidth, 0.0, ivec2(0), 0);
  top = a;
  bot = b;
  return true;
}

vec2 inkOf(Strand s) {
  vec4 p = texelFetch(uPath, s.port, 0);
  return (s.axis == 0) ? p.rg : p.ba;
}

// Path colour. Hue identifies the connected path; the length term drives both
// lightness and chroma, so the short closed loops read as bright saturated
// jewels against the mid-tone of the long percolating path. A very slow, very
// low-frequency hue drift across the frame stops the dominant path from being
// one dead flat colour over 6000px without breaking its identity.
vec3 cordColour(vec2 ink, vec2 wp) {
  float hue = uInk.x + uInk.y * ink.x + 0.030 * sin(wp.x * 0.7 - iTime * 0.045);
  float L = mix(0.88, 0.60, ink.y);
  float C = uInk.z * mix(1.30, 0.80, ink.y);
  return oklabRamp(hue, L, C, 0.0);
}

// Round cord: the SDF gives a half-circle cross-section, so a normal follows
// from the distance and its screen-space gradient. Without this the cords are
// flat ribbons and the weave has nothing to catch the light on.
vec3 shadeCord(Strand s, vec3 base, vec2 grad, float lit) {
  float t = clamp(s.d / max(s.w, 1e-5), 0.0, 1.0);
  float h = sqrt(max(0.0, 1.0 - t * t));
  vec3 nrm = normalize(vec3(grad * t * 0.95, h + 0.28));
  const vec3 lightDir = normalize(vec3(-0.42, 0.55, 0.72));
  float dif = max(dot(nrm, lightDir), 0.0);
  float spe = pow(max(reflect(-lightDir, nrm).z, 0.0), 44.0);
  return base * (0.20 + 0.95 * dif * lit) + vec3(1.0, 0.95, 0.88) * spe * 1.7 * lit;
}

void main() {
  vec2 wp = worldFromFrag(gl_FragCoord.xy, iResolution.xy);
  vec2 f = latRot() * wp / (uCell * uZoom) + uGrid * 0.5;

  // The lattice map is a rotation and a uniform scale, so one pixel is this
  // many fine cells everywhere in the frame -- an exact bound for the AA below.
  float px = 1.0 / (uCell * uZoom * iResolution.y);

  // Cord weight drifts on a very low frequency, so the weave is not one uniform
  // gauge over 6000px. The field is smooth enough that two cords meeting at a
  // port differ by a fraction of a per cent and the joint stays invisible.
  gWidth = uWidth * (1.0 + 0.16 * snoise(wp * 0.55 + uGroundOff));

  Strand top, bot;
  tileAt(f, top, bot);

  // Derivatives, taken at top level so control flow is uniform. fwidth is the
  // right AA measure -- it survives any warping of the lattice -- but it spikes
  // where the nearest-strand argmin switches, which is the medial axis between
  // two cords. Bounding it by the analytic pixel size kills those seams without
  // changing the edge anywhere that matters.
  float aaT = min(fwidth(top.d), 2.0 * px) + 1e-5;
  float aaB = min(fwidth(bot.d), 2.0 * px) + 1e-5;
  vec2 gT = vec2(dFdx(top.d), dFdy(top.d));
  vec2 gB = vec2(dFdx(bot.d), dFdy(bot.d));
  gT = length(gT) > 1e-7 ? normalize(gT) : vec2(0.0, 1.0);
  gB = length(gB) > 1e-7 ? normalize(gB) : vec2(0.0, 1.0);

  float covT = (1.0 - smoothstep(top.w - aaT, top.w + aaT, top.d)) * top.a;
  float covB = (1.0 - smoothstep(bot.w - aaB, bot.w + aaB, bot.d)) * bot.a;

  // Ground shadow: the same field sampled along the light direction. Evaluating
  // the tiling a second time rather than offsetting the distance keeps the
  // shadow correct across tile boundaries, and the tile lookup is one texel
  // fetch and four lengths, so it is affordable.
  Strand st, sb;
  float sd = 1e6;
  if (tileAt(f + latRot() * vec2(0.34, -0.30), st, sb)) {
    sd = min(st.d - st.w * st.a, sb.d - sb.w * sb.a);
  }
  float shade = 1.0 - 0.60 * (1.0 - smoothstep(0.0, 0.55, sd));

  // Illumination in world space, independent of the lattice. A broad key light
  // that drifts over minutes gives the frame a focal point; a wide sweep
  // oscillating across x keeps the unlit two-thirds alive without reading as a
  // scroll. Both are far wider than a tile, so they never fight the pattern.
  vec2 dl = (wp - uFocus) * vec2(0.30, 1.0);
  float key = exp(-dot(dl, dl) * 3.2);
  float sweep = exp(-pow((wp.x - uLight.w) * 0.42, 2.0));
  float lit = uLight.x + uLight.y * key + uLight.z * sweep;

  // Ground: gradient-noise mottling rather than a flat tint (#88 got the flat
  // tint answer in five savers and it reads as a dead field at wall scale).
  float mott = fbm(wp * 1.5 + uGroundOff, 3) * 0.5 + 0.5;
  vec3 ground = oklabRamp(uInk.x + 0.47, (0.20 + 0.10 * mott) * (0.60 + 0.65 * lit),
                          0.045, 0.0);

  vec3 col = ground * shade;

  // Contact shadow: the strand underneath darkens where the one above passes
  // over it. This is the cue that makes a crossing read as over/under instead
  // of as two lines meeting.
  float occ = mix(0.26, 1.0, smoothstep(top.w, top.w * 3.0, top.d));
  occ = mix(1.0, occ, top.a);
  col = mix(col, shadeCord(bot, cordColour(inkOf(bot), wp), gB, lit) * occ, covB);
  col = mix(col, shadeCord(top, cordColour(inkOf(top), wp), gT, lit), covT);

  outColor = vec4(col * uLum, 1.0);
}`

export default {
  name: 'Truchet Tiles',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let prog = null, post = null, uniform = null
    let tileTex = null, pathTex = null

    const rng = createRng(seedValue)

    // Fine cells across the short axis. This sets everything else: at 1200px
    // tall, 14 gives ~86px fine cells and ~30px cords, which is the coarse end
    // of legible from across a room. Below ~11 the coarse bundles are so large
    // that only three or four fit the height and the frame loses its weave;
    // above ~17 the cords thin out toward projector-unfriendly hairlines.
    const fineRows = rng.range(11, 17)
    // Lattice rotation. Any angle away from 0 and 90 degrees hides the square
    // grid, which is the artifact #180 calls out; below ~9 degrees the eye
    // still snaps the rows to horizontal, and past ~27 the coarse bundles start
    // to read as a diagonal weave rather than a free-standing knot.
    const theta0 = rng.range(0.16, 0.47) * rng.sign()
    const driftAmp = rng.range(0.010, 0.030)
    const driftRate = rng.range(0.020, 0.045)
    const zoomAmp = rng.range(0.015, 0.035)
    const zoomRate = rng.range(0.017, 0.030)
    // Cord half width as a fraction of a fine cell. Above ~0.24 adjacent cords
    // in a coarse bundle touch and the bundle fills in solid.
    const width = rng.range(0.155, 0.215)
    // Share of crossing tiles. All arcs is a pattern with no crossings at all;
    // all crossings is a basket and loses the winding paths. The interesting
    // range is a clear minority of crossings.
    const pCross = rng.range(0.22, 0.40)
    // Flips per second per tile: a tile holds a layout for 12-22 seconds.
    const beatRate = rng.range(0.045, 0.085)
    const beatSpread = rng.range(0.20, 0.50)
    const waveAngle = rng.angle()
    const waveDir = [Math.cos(waveAngle), Math.sin(waveAngle)]
    // Turns of beat phase per fine cell. At 0.02 the front is about 50 fine
    // cells deep, so roughly one and a half fronts cross the wall at a time.
    const waveK = rng.range(0.012, 0.028)
    const hueBase = rng.next()
    // A quarter turn of hue at most: enough that paths are told apart, little
    // enough that the frame stays one palette instead of a rainbow.
    const hueSpan = rng.range(0.15, 0.28)
    const chroma = rng.range(0.10, 0.14)
    const groundOff = [rng.range(-40, 40), rng.range(-40, 40)]
    const focusHome = [rng.range(-0.28, 0.28), rng.range(-0.14, 0.14)]
    const focusRate = [rng.range(0.010, 0.018), rng.range(0.007, 0.013)]
    const sweepRate = rng.range(0.020, 0.034)

    // Grid state, rebuilt when the canvas aspect changes materially.
    let aspect = 1
    let cellSize = 1 / fineRows
    let Fx = 0, Fy = 0
    let tileBytes = null, pathBytes = null
    let leaves = []
    let parent = null, compSize = null
    let targetHue = null, targetLum = null, curHue = null, curLum = null
    let lastOrient = null
    let nextRebuild = -1
    let seeded = false

    // Port node ids. Horizontal edges (the N/S ports) form an Fx by Fy+1 grid,
    // vertical edges (E/W) an Fx+1 by Fy grid; both are packed into one array
    // so union-find sees a single node space.
    const hEdge = (i, j) => j * Fx + i
    const vEdge = (i, j) => Fx * (Fy + 1) + j * (Fx + 1) + i

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]
        x = parent[x]
      }
      return x
    }

    // Always attach the higher root to the lower, so a path's root *is* its
    // lowest port index. That is what makes the hue stable across a retiling:
    // when a small loop merges into a long path the merged root is almost
    // always the long path's, so the big structure keeps its colour and the
    // loop is the thing that visibly changes.
    function union(a, b) {
      const ra = find(a), rb = find(b)
      if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb
    }

    /** Hue for a path, from its root (its lowest port index). */
    function pathHue(key) {
      let h = (key ^ 0x9e3779b9) >>> 0
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }

    /**
     * Which of the two arc layouts a tile is in right now.
     *
     * Must agree with the shader's port assignment exactly, or this graph gives a
     * path a hue for a wiring the shader is not drawing. The shader takes ports
     * from the NEAREST quarter turn, which flips at phi + 0.5 rather than at the
     * integer beat, so round instead of floor.
     *
     * The crossfade version used `floor(phi)` here while its shader already showed
     * the next layout from tau > 0.5 onward, so the two disagreed for half of
     * every transition. COLOUR_EASE smoothed it into a brief hue lag rather than
     * anything obviously broken, which is presumably why it went unnoticed.
     */
    function orientation(leaf, time) {
      const phi = beatRate * time
        + (leaf.cx * waveDir[0] + leaf.cy * waveDir[1]) * waveK
        + (leaf.phase / 255) * beatSpread
      return ((Math.floor(phi + 0.5) % 2) + 2) % 2
    }

    /**
     * Build the quadtree.
     *
     * Subdivision probability falls off from a per-activation focus, so fine
     * detail concentrates in one region and the rest of the wall carries the
     * large bundles. That is the composition: uniform subdivision would put the
     * same amount of business everywhere, which is the failure this replaces.
     */
    function buildQuadtree() {
      leaves = []
      tileBytes = new Uint8Array(Fx * Fy * 4)
      const fx = Fx * 0.5 + rng.range(-0.22, 0.22) * Fx
      const fy = Fy * 0.5 + rng.range(-0.12, 0.12) * Fy
      // Separate radii: the grid is far wider than it is tall, so a circular
      // falloff would either cover the whole height or pinch to a dot. About a
      // fifth of the width and half the height gives a region the size of one
      // panel of the wall.
      const sx = 0.20 * Fx, sy = 0.50 * Fy

      const emit = (ox, oy, n) => {
        const cross = rng.chance(pCross)
        const phase = rng.int(0, 255)
        const level = MAX_LEVEL - Math.log2(n)
        leaves.push({ ox, oy, n, cross, phase, cx: ox + n / 2, cy: oy + n / 2 })
        for (let j = oy; j < oy + n; j++) {
          for (let i = ox; i < ox + n; i++) {
            const p = (j * Fx + i) * 4
            tileBytes[p] = level
            tileBytes[p + 1] = cross ? 255 : 0
            tileBytes[p + 2] = phase
            tileBytes[p + 3] = 0
          }
        }
      }

      const split = (ox, oy, n, level) => {
        if (level < MAX_LEVEL) {
          const dx = (ox + n / 2 - fx) / sx, dy = (oy + n / 2 - fy) / sy
          const near = Math.exp(-(dx * dx + dy * dy))
          // Level 0 splits more readily than level 1: without the taper the
          // focus region collapses to all-finest and loses its own hierarchy.
          const p = (level === 0 ? 0.28 : 0.16) + near * (level === 0 ? 0.55 : 0.44)
          if (rng.next() < p) {
            const h = n / 2
            split(ox, oy, h, level + 1)
            split(ox + h, oy, h, level + 1)
            split(ox, oy + h, h, level + 1)
            split(ox + h, oy + h, h, level + 1)
            return
          }
        }
        emit(ox, oy, n)
      }

      for (let j = 0; j < Fy; j += MACRO_CELLS) {
        for (let i = 0; i < Fx; i += MACRO_CELLS) split(i, j, MACRO_CELLS, 0)
      }
      lastOrient = new Uint8Array(leaves.length)
    }

    /** Flood the ports and give every connected path a hue and a length. */
    function rebuildPaths(time) {
      for (let i = 0; i < parent.length; i++) parent[i] = i

      for (let li = 0; li < leaves.length; li++) {
        const lf = leaves[li]
        const { ox, oy, n } = lf
        if (lf.cross) {
          // Straight through on both axes.
          for (let k = 0; k < n; k++) {
            union(hEdge(ox + k, oy), hEdge(ox + k, oy + n))
            union(vEdge(ox, oy + k), vEdge(ox + n, oy + k))
          }
          continue
        }
        const o = orientation(lf, time)
        lastOrient[li] = o
        for (let k = 0; k < n; k++) {
          if (o === 0) {
            // SW bundle: S port k to W port k. NE bundle, counting outward
            // from that corner: N port n-1-k to E port n-1-k.
            union(hEdge(ox + k, oy), vEdge(ox, oy + k))
            union(hEdge(ox + n - 1 - k, oy + n), vEdge(ox + n, oy + n - 1 - k))
          } else {
            // SE bundle: S port n-1-k to E port k. NW: N port k to W port n-1-k.
            union(hEdge(ox + n - 1 - k, oy), vEdge(ox + n, oy + k))
            union(hEdge(ox + k, oy + n), vEdge(ox, oy + n - 1 - k))
          }
        }
      }

      compSize.fill(0)
      for (let i = 0; i < parent.length; i++) compSize[find(i)]++
      for (let i = 0; i < parent.length; i++) {
        const r = find(i)
        targetHue[i] = pathHue(r)
        // log2 over 11 puts a 4-port loop near 0.18 and anything past ~2000
        // ports at 1.0, which is the spread these grids actually produce.
        targetLum[i] = Math.min(1, Math.log2(compSize[r]) / 11)
      }
      if (!seeded) {
        curHue.set(targetHue)
        curLum.set(targetLum)
        seeded = true
      }
    }

    /** True when any arc tile has changed layout since the last flood. */
    function orientationsChanged(time) {
      for (let li = 0; li < leaves.length; li++) {
        const lf = leaves[li]
        if (lf.cross) continue
        if (orientation(lf, time) !== lastOrient[li]) return true
      }
      return false
    }

    function easePaths(dt) {
      const k = 1 - Math.exp(-dt / COLOUR_EASE)
      for (let i = 0; i < curHue.length; i++) {
        // Hue is a circle: take the short way round or a path whose hue crosses
        // zero would sweep the entire wheel on its way back.
        let d = targetHue[i] - curHue[i]
        if (d > 0.5) d -= 1
        else if (d < -0.5) d += 1
        let h = curHue[i] + d * k
        curHue[i] = h - Math.floor(h)
        curLum[i] += (targetLum[i] - curLum[i]) * k
      }
      for (let j = 0; j <= Fy; j++) {
        for (let i = 0; i <= Fx; i++) {
          const p = (j * (Fx + 1) + i) * 4
          if (i < Fx) {
            const e = hEdge(i, j)
            pathBytes[p] = curHue[e] * 255
            pathBytes[p + 1] = curLum[e] * 255
          }
          if (j < Fy) {
            const e = vEdge(i, j)
            pathBytes[p + 2] = curHue[e] * 255
            pathBytes[p + 3] = curLum[e] * 255
          }
        }
      }
    }

    function makeTexture(w, h, data) {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
      // Nearest and clamped: these are data tables addressed by texelFetch, not
      // images, and a filtered lookup would blend two unrelated tiles.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return tex
    }

    /**
     * Size and build the lattice for the current canvas.
     *
     * The grid has to cover the frame after rotation, drift and the breathing
     * zoom, so it is sized from the bounding box at the worst-case angle plus a
     * two-macro margin. Off-frame cells cost a few kilobytes of texture and a
     * few thousand union-find nodes, which is nothing, and it means nothing
     * ever has to be rebuilt while the saver runs.
     */
    function buildGrid() {
      aspect = canvasAspect(canvas)
      cellSize = 1 / fineRows
      const maxTheta = Math.abs(theta0) + driftAmp
      const c = Math.abs(Math.cos(maxTheta)), s = Math.abs(Math.sin(maxTheta))
      const hx = 0.5 * aspect, hy = 0.5
      const span = (v) => Math.ceil((2 * v / (cellSize * (1 - zoomAmp))) / MACRO_CELLS + 2) * MACRO_CELLS
      Fx = span(hx * c + hy * s)
      Fy = span(hx * s + hy * c)

      buildQuadtree()

      const nodes = Fx * (Fy + 1) + (Fx + 1) * Fy
      parent = new Int32Array(nodes)
      compSize = new Int32Array(nodes)
      targetHue = new Float32Array(nodes)
      targetLum = new Float32Array(nodes)
      curHue = new Float32Array(nodes)
      curLum = new Float32Array(nodes)
      pathBytes = new Uint8Array((Fx + 1) * (Fy + 1) * 4)
      seeded = false
      nextRebuild = -1

      if (tileTex) gl.deleteTexture(tileTex)
      if (pathTex) gl.deleteTexture(pathTex)
      tileTex = makeTexture(Fx, Fy, tileBytes)
      pathTex = makeTexture(Fx + 1, Fy + 1, pathBytes)
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        buildGrid()

        prog = runtime.createQuadProgram(SHADER)
        uniform = createUniformCache(gl, prog.program)

        // Bloom on the speculars and the lit cords only. Measured peak in the
        // HDR target is ~2.6 (cord base ~0.6 linear, times the key light, plus
        // the specular term); the threshold sits well above the ground and the
        // unlit cords so the dark two-thirds of the frame stay crisp.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 1.15 * luminanceScale(canvas),
            knee: 0.35,
            intensity: 0.30,
            radius: 0.9,
          },
          tonemap: 'aces',
          dither: true,
        })

        runtime.start((time, frame, glCtx, rt) => {
          if (Math.abs(canvasAspect(canvas) / aspect - 1) > 0.02) buildGrid()

          // Reflooding is cheap but pointless between flips, so it waits for a
          // layout to actually change and then rate-limits itself.
          if (nextRebuild < 0 || (time >= nextRebuild && orientationsChanged(time))) {
            rebuildPaths(time)
            nextRebuild = time + REBUILD_INTERVAL
          }
          easePaths(rt.dt)
          gl.bindTexture(gl.TEXTURE_2D, pathTex)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Fx + 1, Fy + 1,
                           gl.RGBA, gl.UNSIGNED_BYTE, pathBytes)

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }

          const theta = theta0 + driftAmp * Math.sin(time * driftRate)
          const zoom = 1 + zoomAmp * Math.sin(time * zoomRate)
          const focusX = focusHome[0] * aspect + 0.30 * aspect * Math.sin(time * focusRate[0])
          const focusY = focusHome[1] + 0.13 * Math.sin(time * focusRate[1] + 1.3)
          const sweepX = 0.42 * aspect * Math.sin(time * sweepRate)

          prog.draw(time, frame, (g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, tileTex)
            g.uniform1i(uniform('uTile'), 0)
            g.activeTexture(g.TEXTURE1)
            g.bindTexture(g.TEXTURE_2D, pathTex)
            g.uniform1i(uniform('uPath'), 1)
            g.activeTexture(g.TEXTURE0)
            g.uniform2f(uniform('uGrid'), Fx, Fy)
            g.uniform1f(uniform('uCell'), cellSize)
            g.uniform1f(uniform('uTheta'), theta)
            g.uniform1f(uniform('uZoom'), zoom)
            g.uniform1f(uniform('uWidth'), width)
            g.uniform3f(uniform('uWave'), waveDir[0], waveDir[1], waveK)
            g.uniform2f(uniform('uBeat'), beatRate, beatSpread)
            g.uniform2f(uniform('uFocus'), focusX, focusY)
            g.uniform4f(uniform('uLight'), 0.30, 1.15, 0.40, sweepX)
            g.uniform3f(uniform('uInk'), hueBase, hueSpan, chroma)
            g.uniform2f(uniform('uGroundOff'), groundOff[0], groundOff[1])
            g.uniform1f(uniform('uLum'), luminanceScale(canvas))
          })

          if (post) post.present()
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (prog) { prog.destroy(); prog = null }
        if (gl) {
          if (tileTex) { gl.deleteTexture(tileTex); tileTex = null }
          if (pathTex) { gl.deleteTexture(pathTex); pathTex = null }
        }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
        uniform = null
        leaves = []
      },
    }
  },
}
