// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Reaction-Diffusion (Gray-Scott) — organic patterns that grow, divide and
 * crawl, rendered as a lit, translucent film rather than a heatmap.
 *
 * Three passes per frame (issue #124):
 *
 *   1. PARAM  — a low-frequency noise field that assigns every cell its own
 *      (feed, kill) pair, blended from three regimes, plus a curl-noise
 *      advection velocity. One pass at grid resolution, so the simulation
 *      reads it as a texture instead of evaluating noise 8x per frame.
 *   2. SIM    — Gray-Scott on a ping-pong float texture, several substeps per
 *      frame, toroidal, with upwind advection by the param field's velocity.
 *   3. DISPLAY — the B concentration treated as a height field: normal from its
 *      gradient, two lights, subsurface translucency and thin-film speculars,
 *      into the HDR post chain for bloom / ACES / dither.
 *
 * Per-activation variation: which three regimes coexist, how they are laid out
 * and how fast they migrate, the flow field, palette phase, the initial seeding
 * curve and the reseed cadence.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, createFloatTarget, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache, canvasAspect } from './glsl-lib.js'
import { createPostChain } from './post-fx.js'
import { createRng } from './seed.js'

// -----------------------------------------------------------------------------
// Pass 1: the parameter field
// -----------------------------------------------------------------------------
// Gray-Scott's (feed, kill) pair is the single biggest lever on morphology, and
// holding it constant across the frame shows exactly one of the system's many
// behaviours. Varying it in space is what produces the "Gray-Scott zoo" look --
// worms crawling into a spot field, mitosis at one end and solitons at the
// other -- and it is the whole reason this pass exists.
const PARAM_FRAG = `#version 300 es
precision highp float;
${GLSL.simplex2d}
uniform vec2 uTexel;
uniform float uTime;
uniform float uAspect;
uniform vec4 uFeeds;       // three active regimes plus the quench point
uniform vec4 uKills;       // ... and their kill values
uniform vec4 uBias;        // per-component area bias, in log-weight units
uniform float uFieldScale; // regime zones per screen height
uniform vec2 uFieldOrigin; // per-activation offset into the noise field
uniform float uFlowScale;  // curl-noise frequency relative to the regime field
uniform float uAdvect;     // peak advection speed, cells per substep
out vec4 outParam;

// Seamlessly tiling gradient noise over the unit square.
//
// This has to tile, and it is not a nicety. The simulation domain is a torus
// (REPEAT on the state texture), so a cell at u=0.999 diffuses into a cell at
// u=0.001. If the parameter field is not periodic, those two neighbours are
// running different chemistry, and a permanent reaction front pins itself to
// the seam -- which the lighting pass then renders as a bright line down all
// four edges. It was clearly visible before this.
//
// The construction is the standard four-copy blend: sample the field at q and
// at q shifted back by each period, then interpolate with u itself. At u.x = 1
// the weight sits entirely on the copy shifted by P.x, which is by definition
// the value at u.x = 0. A uniform offset (the drift below) is applied to all
// four samples, so it does not break the periodicity.
float tileNoise(vec2 u, vec2 P, vec2 offset) {
  u = fract(u);
  vec2 q = u * P + offset;
  float a = snoise(q);
  float b = snoise(q - vec2(P.x, 0.0));
  float c = snoise(q - vec2(0.0, P.y));
  float d = snoise(q - P);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Curl of the tiling field, i.e. treating it as a stream function. Taking the
// curl of a periodic scalar keeps the flow both periodic AND divergence-free,
// so it shears the chemistry without compressing or rarefying it.
vec2 tileCurl(vec2 u, vec2 P, vec2 offset) {
  const float e = 0.004;
  float n1 = tileNoise(u + vec2(0.0, e), P, offset);
  float n2 = tileNoise(u - vec2(0.0, e), P, offset);
  float n3 = tileNoise(u + vec2(e, 0.0), P, offset);
  float n4 = tileNoise(u - vec2(e, 0.0), P, offset);
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // Aspect-corrected periods (issue #114): scaling x by the aspect ratio keeps
  // noise features round, so the wall gets a row of circular zones rather than
  // the same square field stretched 5:1.
  vec2 P = vec2(uAspect, 1.0) * uFieldScale;

  // Four decorrelated fields, each drifting in its own direction. Sharing one
  // drift vector would translate the whole regime map sideways; independent
  // drifts make the zones grow into and displace each other instead, so the
  // composition keeps changing across a 10-minute rotation slot. 0.005 units
  // per second re-arranges the map about once every three minutes.
  vec4 g = vec4(
    tileNoise(uv, P, uFieldOrigin + vec2( 0.0060,  0.0042) * uTime),
    tileNoise(uv, P, uFieldOrigin + vec2(11.31, 4.77) + vec2(-0.0051, 0.0068) * uTime),
    tileNoise(uv, P, uFieldOrigin + vec2(-6.13, 9.21) + vec2( 0.0034, -0.0059) * uTime),
    tileNoise(uv, P, uFieldOrigin + vec2(17.9, -13.4) + vec2(-0.0038, -0.0047) * uTime));

  // Softmax rather than a plain average. An average sits near the centroid of
  // the components almost everywhere, which is one regime again; the
  // exponential lets a single field dominate over most of its zone and confines
  // the blend to the boundaries between them. uBias shifts how much area each
  // component claims.
  //
  // Blends among the three live regimes are guaranteed to stay in the
  // physically useful part of parameter space, because the existence region
  // k < sqrt(f)/2 - f is convex (sqrt(f)/2 - f is concave), so any weighted
  // average of points that each satisfy the bound satisfies it too. That is
  // why blending curated points is safe where sampling (f,k) freely is not.
  //
  // The fourth component deliberately breaks that: it sits OUTSIDE the bound,
  // so B decays to zero wherever it dominates. Without it there is no negative
  // space in the long run -- Gray-Scott grows outward from wherever B exists
  // and, given ten minutes, a live regime fills every cell it can reach. The
  // quench zones are what the pattern has to grow around, and because they
  // drift, structures are continually eaten at one edge and regrown at another.
  vec4 w = exp(g * 3.5 + uBias);
  w /= dot(w, vec4(1.0));

  // Flow field, finer than the regime zones so structures shear within a zone
  // rather than the zone being moved bodily. Softly saturated rather than hard
  // clamped: the raw curl runs to ~20 in these units, and a hard clamp would
  // flatten it to a constant-speed field with no slow water anywhere.
  vec2 v = tileCurl(uv, P * uFlowScale, uFieldOrigin.yx);
  v = v * (uAdvect / (8.0 + length(v)));

  outParam = vec4(dot(w, uFeeds), dot(w, uKills), v);
}`

// -----------------------------------------------------------------------------
// Pass 2: the simulation
// -----------------------------------------------------------------------------
const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uParam;
uniform vec2 uTexel;
uniform vec2 uGrid;         // grid size in cells, for cell-space distances
uniform vec4 uSeedSeg;      // seed stroke endpoints in uv
uniform float uSeedRadius;  // stroke radius in cells; <= 0 disables
uniform float uSeedFeedMax; // reseeding only ignites below this feed rate
out vec4 outState;

// Distance from p to segment ab. Used in cell space so the splat is round on
// the wall, where a uv-space radius would be a 5:1 ellipse.
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // Neighbours are kept separately rather than accumulated straight into the
  // Laplacian because the upwind advection term below needs the individual
  // axis neighbours. Sampling is toroidal: the caller sets REPEAT, so a read
  // past an edge lands on the opposite side instead of a clamped duplicate.
  vec2 s  = texture(uState, uv).xy;
  vec2 xl = texture(uState, uv - vec2(uTexel.x, 0.0)).xy;
  vec2 xr = texture(uState, uv + vec2(uTexel.x, 0.0)).xy;
  vec2 yd = texture(uState, uv - vec2(0.0, uTexel.y)).xy;
  vec2 yu = texture(uState, uv + vec2(0.0, uTexel.y)).xy;
  vec2 dl = texture(uState, uv + vec2(-uTexel.x, -uTexel.y)).xy;
  vec2 dr = texture(uState, uv + vec2( uTexel.x, -uTexel.y)).xy;
  vec2 ul = texture(uState, uv + vec2(-uTexel.x,  uTexel.y)).xy;
  vec2 ur = texture(uState, uv + vec2( uTexel.x,  uTexel.y)).xy;

  // 9-point Laplacian with the standard 0.2 / 0.05 weights.
  vec2 lap = (xl + xr + yd + yu) * 0.2 + (dl + dr + ul + ur) * 0.05 - s;

  vec4 par = texture(uParam, uv);
  float feed = par.x, kill = par.y;
  vec2 vel = par.zw;

  // Upwind advection. A central difference would be unconditionally unstable
  // here; taking the difference from whichever neighbour is upstream is stable
  // for |v| < 1 cell/step and only adds a numerical diffusion of |v|/2, which
  // at the speeds used is three orders of magnitude below dB.
  vec2 gx = vel.x > 0.0 ? (s - xl) : (xr - s);
  vec2 gy = vel.y > 0.0 ? (s - yd) : (yu - s);
  vec2 adv = vel.x * gx + vel.y * gy;

  float A = s.x, B = s.y;
  // Canonical Gray-Scott diffusion rates (Karl Sims). Higher rates diffuse
  // the field to a uniform value within a few steps -> solid color, so keep
  // these modest. The 2:1 ratio between them is what makes the system pattern
  // at all -- it is Turing's short-range activator, long-range inhibitor.
  float dA = 0.2097, dB = 0.105;
  float reaction = A * B * B;
  float na = A + (dA * lap.x - reaction + feed * (1.0 - A)) - adv.x;
  float nb = B + (dB * lap.y + reaction - (kill + feed) * B) - adv.y;

  // Seeding stroke: a soft-edged capsule rather than the old hard disc, so a
  // reseed does not announce itself as a perfect circle appearing from nowhere.
  //
  // Gated on the LOCAL parameters, which is the whole reason the reseed is safe
  // now that the field varies. Low-feed regimes (solitons, moving spots)
  // genuinely burn out and need re-ignition; high-feed ones (coral, u-skate)
  // already fill their zone, and igniting them again is what turned a long run
  // into an undifferentiated sheet of texture. The second gate is the existence
  // bound itself: igniting inside a quench zone would only produce a splat that
  // fades over the next second, which reads as a glitch.
  if (uSeedRadius > 0.0) {
    vec2 cell = uv * uGrid;
    float d = sdSegment(cell, uSeedSeg.xy * uGrid, uSeedSeg.zw * uGrid);
    float m = 1.0 - smoothstep(uSeedRadius * 0.55, uSeedRadius, d);
    m *= 1.0 - smoothstep(uSeedFeedMax * 0.85, uSeedFeedMax, feed);
    m *= smoothstep(0.0, 0.004, sqrt(feed) * 0.5 - feed - kill);
    nb = max(nb, m);
    na = min(na, mix(1.0, 0.25, m));
  }

  outState = vec4(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}`

// -----------------------------------------------------------------------------
// Pass 3: display
// -----------------------------------------------------------------------------
// The concentration is a height field, so shade it as one. A colour-mapped
// Gray-Scott reads as a data visualisation; the same simulation with a normal,
// a specular and some translucency reads as enamel or living tissue, which is
// what the pattern actually resembles. Output is HDR -- the speculars run well
// past 1.0 so the post chain's bright pass has something to find (issue #140:
// do not pre-tonemap before the chain).
const DISPLAY_FRAG = `#version 300 es
precision highp float;
${GLSL.palette}
uniform sampler2D uState;
uniform sampler2D uParam;
uniform vec2 uResolution;
uniform vec2 uSimTexel;   // one simulation cell, in uv
uniform float uTime;
uniform vec3 uPhase;      // per-activation palette phase
uniform vec2 uFeedSpan;   // min/max feed across the active regimes
uniform float uExposure;
uniform int uDirect;      // 1 when there is no post chain to tonemap for us
out vec4 outColor;

// ACES filmic (Narkowicz), only for the no-float-extension fallback path.
vec3 tonemapACES(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Height of the film. The smoothstep window is deliberately narrow and low: B
// spends most of its range near zero, and a wider window flattens the ridges
// that carry all the surface detail.
float height(vec2 uv) {
  return smoothstep(0.06, 0.40, texture(uState, uv).y);
}

void main() {
  // The grid is allocated at the canvas aspect ratio, so the full canvas maps
  // to the full texture with no correction needed and no stretch.
  vec2 uv = gl_FragCoord.xy / uResolution;

  float h = height(uv);
  // Central differences over one simulation cell. The state texture is sampled
  // LINEAR here, so this is a smooth gradient rather than a per-cell staircase.
  float hx = height(uv + vec2(uSimTexel.x, 0.0)) - height(uv - vec2(uSimTexel.x, 0.0));
  float hy = height(uv + vec2(0.0, uSimTexel.y)) - height(uv - vec2(0.0, uSimTexel.y));

  // 2.2 is a slope exaggeration: a real interface climbs 0 -> 1 over about two
  // cells, which is far too gentle to catch a specular at this scale.
  vec3 n = normalize(vec3(-hx * 2.2, -hy * 2.2, 1.0));
  float edge = clamp(length(vec2(hx, hy)) * 1.6, 0.0, 1.0);

  // Key light rotates once every ~2 minutes so the relief keeps re-reading
  // without the motion being noticeable as motion.
  float a = 6.28318530718 * uPhase.y + uTime * 0.05;
  vec3 key  = normalize(vec3(cos(a) * 0.75, sin(a) * 0.50, 0.62));
  vec3 fill = normalize(vec3(-cos(a) * 0.60, -sin(a) * 0.40, 0.35));

  // Wrapped diffuse rather than plain N.L: light wrapping past the terminator
  // is the cheap stand-in for subsurface scattering, and without it the shaded
  // side of every ridge goes flat black.
  float wrapKey  = clamp((dot(n, key)  + 0.35) / 1.35, 0.0, 1.0);
  float wrapFill = clamp((dot(n, fill) + 0.45) / 1.45, 0.0, 1.0);
  float specKey  = pow(clamp(dot(n, normalize(key  + vec3(0.0, 0.0, 1.0))), 0.0, 1.0), 68.0);
  float specFill = pow(clamp(dot(n, normalize(fill + vec3(0.0, 0.0, 1.0))), 0.0, 1.0), 26.0);
  float fresnel  = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);

  // Where in the regime map this pixel sits, normalised across the three active
  // regimes. Tinting by it makes the zones legible as broad colour families
  // even in the A-rich gaps where there is no pattern to read.
  float feed = texture(uParam, uv).x;
  float rc = clamp((feed - uFeedSpan.x) / max(uFeedSpan.y - uFeedSpan.x, 1e-4), 0.0, 1.0);

  // OKLab throughout: a hue sweep at controlled lightness and chroma, so the
  // ramp has no muddy midpoint and lightness is carried by the LIGHTING rather
  // than pulsing with the hue.
  float hue = uPhase.x + 0.13 * rc + 0.08 * h + 0.015 * sin(uTime * 0.05);
  vec3 tissue    = oklabRamp(hue, mix(0.42, 0.80, h), 0.12, 0.0);
  vec3 substrate = oklabRamp(hue + 0.47, 0.20, 0.05, 0.0);
  vec3 albedo = mix(substrate, tissue, h);

  // Thin-film tint on the highlights: near-white with a hue that walks with
  // film thickness, which is what stops the speculars reading as grey plastic.
  vec3 film = oklabRamp(uPhase.z + h * 0.45 + 0.25 * edge, 0.92, 0.075, 0.0);

  vec3 col = albedo * (0.10 + 0.75 * wrapKey + 0.20 * wrapFill);
  // Translucency: thin ridges glow from within. h*h biases it to the thickest
  // structures so the gaps stay genuinely dark and the wall keeps its blacks.
  col += tissue * (0.50 * h * h * (0.35 + 0.65 * edge));
  col += film * (3.2 * specKey + 0.9 * specFill) * h;
  col += film * 0.45 * fresnel * h;

  // Very mild vignette in aspect-corrected space. At 5:1 this darkens the far
  // ends of the wall by ~15%, which gives the eye a centre without reading as
  // a dirty lens.
  vec2 q = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  col *= 1.0 - 0.15 * clamp(dot(q, q) * 0.35, 0.0, 1.0);
  col *= uExposure;

  if (uDirect == 1) {
    col = tonemapACES(col);
    col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  }
  outColor = vec4(col, 1.0);
}`

// Gray-Scott (feed, kill) regimes, each a qualitatively different morphology
// from the well-known "Gray-Scott zoo". This pair is by far the biggest lever on
// what the simulation looks like, and it was previously a single hardcoded point
// -- so the saver only ever showed one of the many behaviours the system has.
// Three are now active at once, blended across space by the parameter pass.
//
// Curated rather than sampled: most of (f,k) space either dies to a uniform
// field within seconds or saturates to solid B, and both look broken on a wall.
//
// Every pair here satisfies the Gray-Scott existence bound k < sqrt(f)/2 - f,
// below which no non-trivial steady state exists and B decays to zero -- i.e.
// the screen fades to the flat background and stays there. Worth stating
// explicitly because it is not obvious by eye on a short preview, and because
// several plausible-looking literature coordinates (including the f=0.0367,
// k=0.0649 pair this saver originally shipped) sit outside it; that one survives
// in practice only because the periodic reseed keeps re-injecting B.
// If you add a regime, check it against the bound. Blends of entries in this
// table need no separate check -- see the convexity argument in PARAM_FRAG.
const REGIMES = [
  { feed: 0.0367, kill: 0.0573, name: 'mitosis' },
  { feed: 0.0545, kill: 0.0604, name: 'coral' },
  { feed: 0.0295, kill: 0.0547, name: 'worms' },
  { feed: 0.0250, kill: 0.0524, name: 'solitons' },
  { feed: 0.0390, kill: 0.0579, name: 'labyrinth' },
  { feed: 0.0180, kill: 0.0476, name: 'moving spots' },
  { feed: 0.0620, kill: 0.0606, name: 'u-skate' },
  { feed: 0.0340, kill: 0.0564, name: 'spots and stripes' }
]

// REGIMES grouped by how much of their zone they eventually fill. The triple
// that coexists in one activation is drawn one from each group rather than
// three at random, and that is a composition decision, not a cosmetic one:
// three dense regimes fill the whole wall with texture within a couple of
// minutes and leave the eye nowhere to rest, which is exactly what the first
// version of this rewrite did. One sparse regime guarantees negative space, one
// dense one guarantees somewhere busy, and the mid one gives them a border to
// meet along.
// The fourth component of the parameter field, deliberately OUTSIDE the
// Gray-Scott existence bound k < sqrt(f)/2 - f: at f=0.030 the bound is 0.0566,
// and 0.0640 clears it by enough that B decays instead of lingering. Kept out
// of REGIMES precisely because everything in that table has to satisfy the
// bound; this one is the exception, and it is the exception on purpose. It is
// what supplies the negative space over a long run.
const QUENCH = { feed: 0.0300, kill: 0.0640 }

const SPARSE = [3, 5]              // solitons, moving spots -- isolated, mostly empty
const MID = [0, 2, 4, 7]           // mitosis, worms, labyrinth, spots and stripes
const DENSE = [1, 6]               // coral, u-skate -- fill their zone

// Area bias per component (sparse, mid, dense, quench), in log-weight units fed
// to the parameter pass's softmax. Tuned by eye against long runs: the dense
// regime is pushed down and the quench pushed up because the failure mode is
// always the same one -- everything alive, everything full, nowhere to rest.
// The resulting split is roughly 30/22/16/32 percent of the frame.
const GROUP_BIAS = [0.45, 0.15, -0.20, 0.50]

// Frames between parameter-field updates. The field drifts on a scale of
// minutes, so re-deriving it every frame spends the noise budget on a picture
// that has not changed. At 10 it still updates six times a second, far finer
// than the drift, and it is what pays for the four-tap tiling construction.
const PARAM_EVERY = 10

// On-screen size of one chemical cell, in device pixels. This is the constant
// the whole "giant square pixels" complaint reduces to: the saver used to run a
// fixed 320x320 grid whatever the canvas was, which on the 6000x1200 wall is a
// 19x10 pixel block per cell.
//
// 5px is chosen against the pattern's own feature size rather than against
// pixels: a Gray-Scott structure is roughly ten cells across, so 5px cells put
// a spot at ~50px, which is ~8cm on a 10m wall -- readable from across the room
// and fine enough that no individual cell is resolvable.
const TARGET_CELL_PX = 5

// Total cell budget, applied by scaling BOTH axes so the grid keeps the canvas
// aspect ratio. A per-axis cap cannot do that: capping width at 640 on a
// 6000x1200 canvas while the height passes through unclamped reintroduces
// exactly the stretch this is meant to remove.
//
// 420k cells covers the wall (1200x240 = 288k) with headroom, and bounds the
// worst case on an unexpectedly large canvas.
const MAX_CELLS = 420000

// Substep bounds. More substeps per frame means faster chemistry, not a better
// picture, so this is the first thing to give up under load (issue #116).
// Below 3 the pattern visibly crawls, so that is the floor.
const MIN_STEPS = 3
const MAX_STEPS = 8

// Curated base hues, in OKLab turns, for the tissue/substrate ramp.
//
// The owner rejected the gold/amber look this saver kept landing on, so the base
// hue is no longer a free `rng.next()`. Picking from a list rather than clamping
// to one arc keeps the per-activation variety that makes a 10-minute rotation
// slot feel alive, while making the disliked band unreachable by construction.
//
// WHY THESE SPECIFIC NUMBERS
//
// Measured, not chosen by eye. Converting oklabRamp(t, 0.80, 0.12) — the tissue
// highlight, which is what dominates the frame — back to sRGB across the wheel
// puts gold and amber at turns 0.105 to 0.260. (Sample finely: a 50-step scan
// reads the lower edge as 0.12 and would leave almost no margin.)
//
// Excluding that band is necessary but NOT sufficient, because the shader adds
// drift to the base:
//
//   hue = uPhase.x + 0.13 * rc + 0.08 * h + 0.015 * sin(...)
//
// `rc` and `h` are both clamped to [0,1], so a single activation sweeps an arc of
// [base - 0.015, base + 0.225] — nearly a quarter of the wheel. A base just below
// the band therefore walks straight into it. Requiring the WHOLE swept arc to
// clear 0.09..0.28 (the measured band plus a margin) leaves bases in
// 0.295..0.865, i.e. 57% of the wheel, and every entry below sits inside that.
// test/reaction-diffusion-palette.test.js re-derives this and will fail if an
// entry, the drift coefficients or the band assumption changes.
//
// Only the base hue is curated. `uPhase.y` is the key-light angle, not a colour,
// and `uPhase.z` tints the thin-film specular at L=0.92 C=0.075 — a near-white
// iridescence whose own drift spans 0.70 turns, so it cannot avoid any hue and
// does not read as gold at that chroma. Both stay free.
export const PALETTE_BASE_HUES = [
  0.30,  // lichen    — yellow-green into teal
  0.38,  // verdigris — green into teal
  0.46,  // lagoon    — teal into cyan
  0.55,  // cyan      — teal into pale blue
  0.63,  // glacier   — cyan into violet
  0.72,  // amethyst  — pale blue into magenta
  0.80,  // orchid    — blue into pink
  0.84   // rose      — violet into warm red
]

export default {
  name: 'Reaction Diffusion',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, display = null, param = null, pp = null
    let paramTarget = null, chain = null
    let uSim = null, uDisplay = null, uParam = null
    let simW = 64, simH = 64
    let gridW = 0, gridH = 0   // canvas size the current grid was built for
    let seedTimer = 0
    let paramAge = 0
    let steps = MAX_STEPS
    let smoothedDt = 1 / 60
    let stepCooldown = 0

    const rng = createRng(seedValue)

    // One regime from each density group, so the three are always distinct and
    // always span the zoo. Which three coexist is the largest single difference
    // between two activations: 2 x 4 x 2 = 16 combinations.
    const live = [SPARSE, MID, DENSE].map((group) => REGIMES[rng.pick(group)])
    const active = [...live, QUENCH]
    const feeds = active.map((r) => r.feed)
    const kills = active.map((r) => r.kill)
    const feedSpan = [Math.min(...feeds), Math.max(...feeds)]
    // Reseeding only ignites below this, i.e. in the sparse half of the map.
    const liveFeeds = live.map((r) => r.feed)
    const seedFeedMax = 0.5 * (Math.min(...liveFeeds) + Math.max(...liveFeeds))

    // Noise periods per screen height. Below ~1.6 the four-copy tiling blend
    // samples points that are still correlated and the field loses most of its
    // contrast; much above 2.6 the zones get smaller than the structures they
    // are supposed to host, so the regimes stop being legible. On the 5:1 wall
    // this gives 8-13 periods across the width.
    const fieldScale = rng.range(1.6, 2.6)
    const fieldOrigin = [rng.range(-40, 40), rng.range(-40, 40)]
    // Flow field frequency relative to the regime field. Finer, so structures
    // shear within a zone instead of the zone sliding as a block.
    const flowScale = rng.range(1.4, 2.6)
    // Peak advection, in cells per substep. Derived from what it should look
    // like: at ~480 substeps/second, 0.006 moves the pattern about three cells
    // per second -- a drift across a feature's own width in a few seconds. An
    // order of magnitude more and the flow shears the chemistry apart before it
    // can organise.
    const advect = rng.range(0.004, 0.009)
    // .x is the curated base hue (see PALETTE_BASE_HUES); .y is the key-light
    // angle and .z the thin-film tint, both free.
    const palettePhase = [rng.pick(PALETTE_BASE_HUES), rng.next(), rng.next()]
    // Reseed cadence in frames. Previously a fixed 240, so the first reseed
    // always landed at the same moment. Longer now than it used to be: with a
    // parameter field the pattern no longer settles on its own.
    const reseedEvery = rng.int(420, 900)
    // Phases (radians) for the reseed path below.
    const strokePhase = [rng.phase(), rng.phase(), rng.phase()]

    // Initial-condition geometry, drawn here rather than inside makeSeed() so a
    // stop/start cycle replays the same opening composition -- makeSeed runs on
    // every grid rebuild, and drawing there would consume the stream.
    const arc = {
      amp: rng.range(0.10, 0.28),
      k1: rng.range(0.7, 1.6),
      k2: rng.range(2.1, 3.7),
      p1: rng.phase(),
      p2: rng.phase(),
      base: rng.range(0.35, 0.65),
      steps: rng.int(26, 44),
      radius: rng.range(0.012, 0.024)   // as a fraction of grid height
    }
    // Satellites in normalised coordinates, so they land in the same relative
    // place whatever the grid resolution turns out to be.
    const satellites = Array.from({ length: rng.int(3, 7) }, () => [rng.next(), rng.next()])

    /**
     * Where the next seeding stroke goes, and which way it points.
     *
     * Not uniformly random: successive seeds walk a slow Lissajous path across
     * the frame, so over a long run the reseeds trace a composed line through
     * the field instead of peppering it. The x figure is stretched to the full
     * width and the y figure runs at an incommensurate rate, so the path does
     * not close on itself within a rotation slot.
     */
    function seedStroke(time) {
      const cx = 0.5 + 0.42 * Math.sin(time * 0.021 + strokePhase[0])
      const cy = 0.5 + 0.34 * Math.sin(time * 0.037 + strokePhase[1])
      const ang = time * 0.11 + strokePhase[2]
      // Half-length in uv. Short: this is an ignition point, not a drawing.
      const hx = 0.018 * Math.cos(ang)
      const hy = 0.018 * Math.sin(ang) * (simW / Math.max(simH, 1))
      return [cx - hx, cy - hy, cx + hx, cy + hy]
    }

    /**
     * Initial state: A=1 everywhere, with B seeded along a noise-perturbed arc
     * spanning the frame plus a few detached satellites.
     *
     * Seeding with intent rather than scattering discs matters more than it
     * sounds: Gray-Scott grows outward from wherever B exists, so the initial
     * condition is the composition for the first minute of the run. An arc
     * gives a front that sweeps across the wall; uniform random blobs give an
     * even wash of texture with nothing to look at.
     */
    function makeSeed() {
      const data = new Float32Array(simW * simH * 4)
      for (let i = 0; i < simW * simH; i++) {
        data[i * 4 + 0] = 1.0
        data[i * 4 + 3] = 1.0
      }
      const radius = Math.max(2, Math.round(simH * arc.radius))
      const splat = (cx, cy) => {
        for (let y = -radius; y <= radius; y++) {
          for (let x = -radius; x <= radius; x++) {
            if (x * x + y * y > radius * radius) continue
            // Toroidal, matching the simulation's wrap.
            const px = ((cx + x) % simW + simW) % simW
            const py = ((cy + y) % simH + simH) % simH
            data[(py * simW + px) * 4 + 1] = 1.0
          }
        }
      }

      // The arc: amplitude and both wave numbers vary per activation, so the
      // front is a different shape every time without ever being a straight
      // line or a full sine wave.
      for (let i = 0; i < arc.steps; i++) {
        const t = i / (arc.steps - 1)
        const y = arc.base + arc.amp * (
          0.7 * Math.sin(t * arc.k1 * 6.283 + arc.p1) +
          0.3 * Math.sin(t * arc.k2 * 6.283 + arc.p2))
        splat(Math.round(t * (simW - 1)), Math.round(Math.min(0.97, Math.max(0.03, y)) * (simH - 1)))
      }
      // Satellites, so growth also starts away from the arc and the two fronts
      // meet somewhere unplanned.
      for (const [sx, sy] of satellites) {
        splat(Math.round(sx * (simW - 1)), Math.round(sy * (simH - 1)))
      }
      return data
    }

    /** Allocate the grid and the simulation targets for the current canvas. */
    function buildGrid() {
      let w = canvas.width / TARGET_CELL_PX
      let h = canvas.height / TARGET_CELL_PX
      const shrink = Math.sqrt(MAX_CELLS / Math.max(w * h, 1))
      if (shrink < 1) { w *= shrink; h *= shrink }
      simW = Math.max(64, Math.round(w))
      simH = Math.max(64, Math.round(h))
      gridW = canvas.width
      gridH = canvas.height
      if (pp) pp.destroy()
      if (paramTarget) { gl.deleteTexture(paramTarget.tex); gl.deleteFramebuffer(paramTarget.fbo) }
      pp = createPingPong(gl, simW, simH, makeSeed())
      paramTarget = createFloatTarget(gl, simW, simH)
      seedTimer = 0
      // Force a parameter pass before the first substep reads the new target.
      paramAge = 0
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        // Size the backing store BEFORE deriving the grid from it. createGLRuntime
        // does not resize on construction, so canvas.width is still the HTML
        // default 300x150 at this point -- deriving the grid from that gave a
        // 64x64 simulation smeared across the whole wall, which is what the
        // "square pixels" report was actually looking at.
        runtime.resize()

        sim = createFullscreenPass(gl, SIM_FRAG)
        display = createFullscreenPass(gl, DISPLAY_FRAG)
        param = createFullscreenPass(gl, PARAM_FRAG)
        // Uniform locations are fixed for a program's lifetime. Looking them up
        // inside the draw callback meant 5 string-keyed driver queries x 8
        // substeps = 40 per frame, for values that never move (issue #115).
        uSim = createUniformCache(gl, sim.program)
        uDisplay = createUniformCache(gl, display.program)
        uParam = createUniformCache(gl, param.program)
        buildGrid()

        // Threshold sits just under the specular peak. The lit surface's
        // diffuse term stays below ~0.9 while a highlight reaches ~3, so this
        // picks out speculars and rim only -- bloom on the highlights, not a
        // haze over the whole field.
        chain = createPostChain(gl, canvas, {
          bloom: { threshold: 0.85, knee: 0.35, intensity: 0.55, radius: 1.15 },
          tonemap: 'aces',
          exposure: luminanceScale(canvas),
          dither: true
        })

        runtime.start((time) => {
          if (canvas.width !== gridW || canvas.height !== gridH) {
            // Wall mode toggles the backing store live. Rebuilding restarts the
            // simulation, which is the honest response: a grid sized for the
            // old canvas would be the stretch bug again.
            buildGrid()
            if (chain) chain.resize()
          }

          // Adaptive substep count (issue #116). Substeps are the dominant cost
          // and the least visible quality axis, so they are what gets traded
          // away when the frame budget is tight. Smoothed and rate-limited so
          // it settles rather than oscillating with every hitched frame.
          smoothedDt = smoothedDt * 0.9 + runtime.dt * 0.1
          if (stepCooldown > 0) stepCooldown -= 1
          else if (smoothedDt > 1 / 45 && steps > MIN_STEPS) { steps -= 1; stepCooldown = 30 }
          else if (smoothedDt < 1 / 57 && steps < MAX_STEPS) { steps += 1; stepCooldown = 30 }

          const aspect = canvasAspect(canvas)

          // Parameter field: not once per substep, and not even once per frame.
          // The regimes drift on a scale of minutes, so re-deriving them eight
          // times a frame would be eight times the noise cost for a picture
          // that has not moved.
          if (paramAge <= 0) {
            paramAge = PARAM_EVERY
            gl.bindFramebuffer(gl.FRAMEBUFFER, paramTarget.fbo)
            gl.viewport(0, 0, simW, simH)
            param.draw((g) => {
              g.uniform2f(uParam('uTexel'), 1 / simW, 1 / simH)
              g.uniform1f(uParam('uTime'), time)
              g.uniform1f(uParam('uAspect'), aspect)
              g.uniform4f(uParam('uFeeds'), feeds[0], feeds[1], feeds[2], feeds[3])
              g.uniform4f(uParam('uKills'), kills[0], kills[1], kills[2], kills[3])
              g.uniform4f(uParam('uBias'), GROUP_BIAS[0], GROUP_BIAS[1], GROUP_BIAS[2], GROUP_BIAS[3])
              g.uniform1f(uParam('uFieldScale'), fieldScale)
              g.uniform2f(uParam('uFieldOrigin'), fieldOrigin[0], fieldOrigin[1])
              g.uniform1f(uParam('uFlowScale'), flowScale)
              g.uniform1f(uParam('uAdvect'), advect)
            })
          }
          paramAge -= 1

          let stroke = null
          seedTimer += 1
          if (seedTimer > reseedEvery) {
            seedTimer = 0
            stroke = seedStroke(time)
          }
          // Radius in cells, so a reseed is the same physical size on any
          // display rather than growing with the grid.
          const seedRadius = Math.max(2.5, simH * 0.02)

          for (let i = 0; i < steps; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
            gl.viewport(0, 0, simW, simH)
            sim.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, pp.read.tex)
              // NEAREST for the simulation read: the chemistry samples exact
              // neighbouring cells, and interpolating them would blur the
              // reaction. REPEAT makes the domain a torus, so patterns leave
              // one edge and return on the other -- CLAMP_TO_EDGE fed the
              // Laplacian duplicated border cells, which pinned structures to
              // the frame edge (issue #113). The display pass sets LINEAR on
              // this same texture, so each pass asserts the state it needs.
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.REPEAT)
              g.uniform1i(uSim('uState'), 0)
              g.activeTexture(g.TEXTURE1)
              g.bindTexture(g.TEXTURE_2D, paramTarget.tex)
              g.uniform1i(uSim('uParam'), 1)
              g.uniform2f(uSim('uTexel'), 1 / simW, 1 / simH)
              g.uniform2f(uSim('uGrid'), simW, simH)
              // Only the first substep of the frame injects, so a reseed is one
              // stroke rather than `steps` copies of it.
              const on = stroke && i === 0
              g.uniform4f(uSim('uSeedSeg'), on ? stroke[0] : 0, on ? stroke[1] : 0,
                on ? stroke[2] : 0, on ? stroke[3] : 0)
              g.uniform1f(uSim('uSeedRadius'), on ? seedRadius : -1)
              g.uniform1f(uSim('uSeedFeedMax'), seedFeedMax)
            })
            pp.swap()
          }

          // Display pass into the HDR target (or straight to screen if float
          // targets are unavailable, in which case the shader tonemaps itself).
          gl.bindFramebuffer(gl.FRAMEBUFFER, chain ? chain.sceneTarget.fbo : null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            // LINEAR for the *display* read only. createPingPong uses NEAREST,
            // which is right for simulation state -- the chemistry must
            // round-trip exactly -- but upscaling a coarse grid with NEAREST is
            // what gave the wall hard-edged blocks (issue #114). REPEAT here
            // too, so the interpolation across the seam blends the two sides
            // of the torus instead of the clamped border.
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.REPEAT)
            g.uniform1i(uDisplay('uState'), 0)
            g.activeTexture(g.TEXTURE1)
            g.bindTexture(g.TEXTURE_2D, paramTarget.tex)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
            g.uniform1i(uDisplay('uParam'), 1)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform2f(uDisplay('uSimTexel'), 1 / simW, 1 / simH)
            g.uniform1f(uDisplay('uTime'), time)
            g.uniform3f(uDisplay('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform2f(uDisplay('uFeedSpan'), feedSpan[0], feedSpan[1])
            g.uniform1f(uDisplay('uExposure'), chain ? 1.0 : luminanceScale(canvas))
            g.uniform1i(uDisplay('uDirect'), chain ? 0 : 1)
          })
          gl.activeTexture(gl.TEXTURE0)
          if (chain) chain.present()
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (display) { display.destroy(); display = null }
        if (param) { param.destroy(); param = null }
        if (pp) { pp.destroy(); pp = null }
        if (paramTarget && gl) {
          gl.deleteTexture(paramTarget.tex)
          gl.deleteFramebuffer(paramTarget.fbo)
        }
        paramTarget = null
        if (chain) { chain.destroy(); chain = null }
        if (runtime) { runtime.destroy(); runtime = null }
        uSim = uDisplay = uParam = null
        gridW = gridH = 0
        steps = MAX_STEPS
        paramAge = 0
        gl = null
      }
    }
  }
}
