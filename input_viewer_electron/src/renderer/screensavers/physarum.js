// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Physarum (slime mould) -- an agent-based transport network that never
 * settles (issue #91).
 *
 * Jones' 2010 model, unchanged in its essentials: every agent has a position
 * and a heading, samples the trail map at three points ahead of it (left,
 * centre, right), turns toward whichever reads strongest, steps forward and
 * deposits. The trail diffuses and decays. Reinforcement plus die-back is the
 * whole algorithm, and the filament network with its branches and junctions is
 * emergent -- nothing here draws a line.
 *
 * Same read-neighbours / write-next shape as reaction-diffusion.js, with one
 * extra stage: agents are not on the grid, so a frame is
 *
 *   nutrient field -> agent update -> diffuse+decay -> deposit (points) -> display
 *
 * (diffuse before deposit, not after -- see step 2 in the frame loop.)
 *
 * WHAT BREAKS, AND WHY THE CONSTANTS ARE WHAT THEY ARE
 *
 * The prototype behind this went through three failures, all parameter balance
 * rather than algorithm (issue #91). They are worth naming because each has an
 * obvious-looking "fix" that is wrong:
 *
 *  1. Saturated white blob. Trail values run well past 1.0 in a dense vein, so
 *     clamping for display flattens every core to flat white. The display pass
 *     therefore TONE-MAPS (v / (v + K_TONEMAP)) and emits HDR into the post
 *     chain; it never clamps. Reducing brightness instead just makes a dim blob.
 *  2. Two thick ropes instead of a network. The sensor offset was large
 *     relative to the grid, so every agent could see -- and joined -- the same
 *     few paths. SENSOR_NEAR/FAR are single-digit cells against a grid
 *     thousands of cells wide, and must stay that way.
 *  3. Filaments too thick, nothing ever died back. Decay too slow. DECAY is
 *     aggressive (a ~5-step half-life); that is what keeps strands thin and
 *     lets abandoned paths vanish, which is what makes the network read as
 *     continuously reorganising rather than merely moving.
 *
 * COMPOSITION ON A 5:1 WALL
 *
 * Plain physarum fills whatever area it is given with one uniform mesh, which
 * on 6000x1200 is exactly the "wall of texture" failure -- nowhere for the eye
 * to land. So the sim runs over a slowly drifting NUTRIENT FIELD (the biology's
 * food sources, and a standard extension of the model). It does three things at
 * once, all of which are composition:
 *
 *   - deposit is scaled by it, so barren regions decay to true black and the
 *     frame gets negative space;
 *   - agents sense it as well as the trail, so they migrate and the network
 *     concentrates into islands;
 *   - sensor distance and speed interpolate across it, so fertile regions grow
 *     a fine dense mesh while barren ones are crossed by long sparse foraging
 *     strands. That is the scale variation a uniform mesh lacks.
 *
 * Because the field drifts (an orbit, not a scroll -- see FOOD_FRAG), the
 * composition itself reorganises over a ten-minute slot.
 *
 * THREE SPECIES
 *
 * The trail map is RGB, one channel per species, and an agent is attracted to
 * its own channel and mildly repelled by the others (crossInhibit). This is
 * the standard multi-species variant, and it earns its keep twice: the colour
 * is then a real property of the simulation rather than a ramp lookup, and the
 * mutual avoidance produces territories and contact boundaries -- more
 * large-scale structure, for free.
 *
 * Per-activation variation: nutrient field offset/scale/threshold and drift
 * phase (the load-bearing one -- it decides where the islands are), sensor and
 * turn angles, speed, deposit, decay, cross-inhibition, species count, and the
 * palette's hue spread.
 */
import {
  createGLRuntime, createFullscreenPass, createPingPong, buildProgram,
  createHdrColorTarget, luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// ---------------------------------------------------------------- sizing

// Canvas pixels per trail cell at 1080p. A filament is one cell wide, so this
// is directly "how many pixels wide is a strand". 2.2 is the prototype's ratio:
// coarser than ~3 and the LINEAR upscale turns strands into soft blobs, finer
// than ~1.5 and a strand is sub-pixel and shimmers as it moves.
const BASE_CELL_PX = 2.2

/**
 * Canvas pixels per trail cell, grown on large displays.
 *
 * A fixed ratio would keep a strand 2.2 device pixels wide everywhere, which is
 * the wrong invariant for a videowall: 6000x1200 over 10m is 1.67mm per pixel,
 * so 2.2px is 3.7mm, and at an 8m viewing distance that subtends about 1.6
 * arcmin -- at the resolving limit of 20/20 vision. The network would read as
 * a shimmer rather than as lines. This is the same argument as
 * MIN_LARGE_DISPLAY_POINT_PX in gl-base.js, one abstraction up: the thing to
 * hold constant is ANGULAR size, not pixel size.
 *
 * Grows as area^0.35 rather than the sqrt used by pointScale, and is capped at
 * 2x. Full sqrt scaling would hold angular size exactly but also divide the
 * cell count by the same factor, and past ~2x the mesh becomes too coarse to
 * fill a 5:1 frame with anything interesting. The wall lands at ~3.4px per
 * strand, about 2.4 arcmin at 8m.
 *
 * Cheaper as a side effect: the wall's grid is 623k cells instead of 1.49M.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {number} canvas pixels per cell
 */
function cellPx(canvas) {
  const ratio = ((canvas.width || 1) * (canvas.height || 1)) / (1920 * 1080)
  return BASE_CELL_PX * Math.min(2.0, Math.max(1, Math.pow(ratio, 0.35)))
}

// Bounds worst-case cost. The diffuse pass is 9 texture fetches per cell per
// substep, so cells are the term that matters. With cellPx() above, 6000x1200
// gives 623k cells; the cap only engages on much larger geometry.
const MAX_TRAIL_CELLS = 2.4e6

// Agents as a fraction of trail cells.
//
// This is the single biggest lever on whether the result is a network or a
// bundle of ropes, and the prototype's 11% is too low here. At 11% the agents
// have no reason to spread: they gather into a handful of fat braids with a web
// between them too faint to read (verified -- it is what the first six
// screenshot rounds looked like). Around 30% there are enough agents to hold
// many filaments open at once, which is the canonical physarum web with visible
// branches, junctions and feathered growing tips. Past ~45% the mesh closes up
// and the die-back stops being visible.
const AGENT_FRACTION = 0.30
// Agents live in a SIDE x SIDE state texture, so the count is SIDE^2.
const MIN_AGENT_SIDE = 64
const MAX_AGENT_SIDE = 640   // ~410k agents, the cost ceiling

// Nutrient field resolution divisor, relative to the trail grid. The field is
// low-frequency by construction, so evaluating fbm at full grid resolution
// would be several million wasted noise evaluations per frame.
const FOOD_DIV = 6

// ---------------------------------------------------------------- dynamics

// Simulation steps per wall-clock second, and the per-frame cap.
//
// Fixed substeps per frame (what reaction-diffusion does) would tie the
// mould's growth rate to refresh rate, so the wall and a 120Hz desk panel
// would show different organisms. An accumulator keeps it wall-clock. The cap
// bounds a stall: without it, a hidden tab returning after five seconds would
// try to run 300 steps in one frame.
const STEP_HZ = 60
const MAX_STEPS_PER_FRAME = 3

// Sensor offsets in cells, interpolated across the nutrient field: short where
// there is food (fine mesh), long where there is none (sparse foraging).
//
// Failure 2 above is why these are single-digit CELLS and not a fraction of the
// grid: they must not scale with it. Against a grid ~1800 cells wide on the
// wall these are a rounding error, which is exactly right -- the mesh spacing
// they produce (roughly 3x the offset) is what sets the network's scale, and a
// grid-relative offset is what collapsed the prototype into two ropes.
//
// The offset-to-speed ratio is the other half. Below about 4 the agents turn
// faster than they travel and the result curls into ribbons rather than
// extending into filaments; these sit at 6-7.5.
const SENSOR_NEAR = 6.0
const SENSOR_FAR = 11.0
// Cells per step, same interpolation. Faster in barren regions so agents cross
// them rather than milling about and depositing a haze.
const SPEED_NEAR = 1.0
const SPEED_FAR = 1.45

// Trail decay per step. 0.865 is a half-life of ~4.8 steps, under a tenth of a
// second at STEP_HZ: aggressive on purpose (failure 3). It is what keeps
// strands thin and lets an abandoned path vanish within a second, which is what
// makes the network read as reorganising rather than merely moving.
const DECAY = 0.865
// How much of the 3x3 box blur is mixed in per step. 1.0 is a full box (pure
// diffusion); slightly under keeps a sharper core on the strand while still
// spreading enough for neighbouring agents to find it.
const DIFFUSE = 0.62
// Absolute floor subtracted after decay. Exponential decay never actually
// reaches zero, so without this the background holds a permanent ghost of every
// path ever taken -- the same quantisation-floor argument as
// createHdrColorTarget, one level up. Small enough not to touch a live strand.
const TRAIL_FLOOR = 2e-4
// Trail level at which an agent's deposit is halved. See DEPOSIT_VERT: this is
// the term that keeps every strand in roughly the same brightness band instead
// of letting a few busy paths run away. Lower saturates harder (a flatter,
// more uniform mesh); higher restores the runaway.
const SATURATE = 1.2
// Trail level at which the SENSOR saturates. See senseAt(): the companion to
// SATURATE on the sensing side. Sized below a healthy vein (~0.5-2) so an
// established filament and a fat braid read as similarly attractive.
const SENSE_SAT = 0.5

// ---------------------------------------------------------------- look

// Tone-map knee: display density is v / (v + K_TONEMAP), so K is the trail
// value that lands on mid-grey.
//
// Measured, not guessed. With the crowding term in place a busy vein settles
// around 1.5-2.5 and the faint web between veins around 0.03-0.1, so K has to
// sit low in that range or the web falls off the bottom of the curve and the
// frame becomes a few bright braids on black. 0.3 puts a vein at ~0.85 and the
// web at ~0.15, both legible; the roll-off above keeps internal structure in
// the brightest cores instead of clipping them flat (failure 1).
const K_TONEMAP = 0.3
// Linear-light gain applied after the tone-map. Above 1.0 by design: the
// brightest cores must exceed 1.0 so the post chain's bright pass sees them and
// ACES has something to roll off. Emitting pre-tonemapped colour here is
// issue #140.
const GAIN = 2.6
// Density exponent applied after the tone-map. 1.0 (linear) because K above is
// already doing the shaping; >1 crushed the faint web that makes this read as a
// network, and <1 lifted the barren regions off black and cost the negative
// space the composition depends on.
const DENSITY_GAMMA = 1.0

// OKLab lightness/chroma for the species colours. L=0.78 is high enough that a
// strand is genuinely bright against ambient room light rather than relying on
// a black surround (issue #88); chroma stays inside sRGB at that lightness for
// every hue (see palettePerceptual's measurements in glsl-lib.js).
const SPECIES_LIGHTNESS = 0.78

// Hue offsets, in OKLab turns, for the three species. Curated rather than
// sampled: three independent hues frequently land either on top of each other
// (one flat colour) or evenly around the wheel (a red/green/blue clown
// palette). Each entry is a deliberate relationship.
const HUE_SPREADS = [
  [0.0, 0.05, 0.11],   // analogous -- one family, e.g. teal through blue
  [0.0, 0.09, 0.34],   // split -- a pair plus one contrasting species
  [0.0, 0.30, 0.58],   // wide -- three clearly distinct hues
  [0.0, 0.04, 0.46]    // near-duplicate pair against a complement
]

// ---------------------------------------------------------------- shaders

// Nutrient field. Rebuilt every frame (it is small) so its drift is continuous
// rather than stepped.
const FOOD_FRAG = /* glsl */`#version 300 es
precision highp float;
${GLSL.simplex2d}
${GLSL.fbm}
uniform vec2 uTexel;
uniform vec2 uOffset;     // per-activation position in the noise field
uniform float uScale;     // features across the SHORT axis
uniform float uAspect;    // grid width / height
uniform float uTime;
uniform float uOmega;     // drift angular rate
uniform float uRadius;    // drift orbit radius in noise units
uniform vec2 uThreshold;  // smoothstep edges shaping the field
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy * uTexel;
  // Isotropic sampling: x is stretched by the aspect so an island is as tall
  // as it is wide. On the wall that means ~5 islands across and ~1 down.
  vec2 q = vec2(p.x * uAspect, p.y) * uScale;
  // An orbit rather than a linear offset. A drifting vec2(t, t) slides the
  // whole composition sideways, which over ten minutes reads as the picture
  // scrolling; an orbit returns the field near its origin while passing
  // through entirely different neighbourhoods on the way.
  q += uOffset + vec2(cos(uTime * uOmega), sin(uTime * uOmega)) * uRadius;
  // 3 octaves: the base decides where the islands are, the upper two give
  // their edges enough raggedness that they do not read as airbrushed blobs.
  float n = fbm(q, 3) * 0.5 + 0.5;
  // Shaped hard so a real fraction of the frame reaches zero. A field that
  // merely dims never produces negative space -- it produces a uniform mesh
  // with uneven brightness, which is the failure this exists to avoid.
  float f = smoothstep(uThreshold.x, uThreshold.y, n);
  outColor = vec4(f, f, f, 1.0);
}`

// Agent update: sense three points ahead, steer, step, wrap.
// State is (x, y, heading, species) in a RGBA32F ping-pong pair. Positions are
// in CELL units, not [0,1], so the sensor offsets below are literally "n cells
// ahead" and stay meaningful when the grid resizes.
const AGENT_FRAG = /* glsl */`#version 300 es
precision highp float;
${GLSL.hash}
uniform sampler2D uAgents;
uniform sampler2D uTrail;
uniform sampler2D uFood;
uniform vec2 uTexel;        // 1 / agent side
uniform vec2 uGrid;         // trail grid size in cells
uniform float uSensorAngle;
uniform float uTurn;
uniform vec2 uSensorDist;   // (near, far) in cells
uniform vec2 uSpeed;        // (near, far) in cells per step
uniform float uCross;       // response to another species' trail (negative)
uniform float uFoodWeight;  // how strongly the nutrient field is sensed
uniform float uJitter;      // per-step heading noise, radians
uniform float uSenseSat;    // trail level at which the sensor saturates
uniform float uStep;        // step counter, decorrelates the per-step randoms
out vec4 outState;

const float TAU = 6.28318530718;

// Attraction weights for one agent: +1 on its own channel, uCross on the
// others. Built branchlessly from the species index so the three species share
// one shader rather than three programs.
vec3 speciesMask(float sp) {
  vec3 own = step(abs(vec3(0.0, 1.0, 2.0) - sp), vec3(0.5));
  return mix(vec3(uCross), vec3(1.0), own);
}

// The grid is toroidal, so every lookup wraps. fract() rather than a REPEAT
// wrap mode because the same targets are sampled un-wrapped by the display
// pass, and a texture cannot have two wrap modes at once.
//
// The sensor response SATURATES rather than being linear in trail strength.
// This is the other half of the anti-runaway pair (see the deposit shader's
// crowding term), and it is what decides whether the result is a network or a
// bundle of ropes. With a linear response the strongest path is always the most
// attractive, so filaments that come near each other merge and never separate
// again -- the frame ends up as a few fat braids over a web too faint to read.
// Saturating means a busy path and a quiet one look nearly equally good once
// both are established, so a filament has no reason to abandon its own route
// for its neighbour's, and the mesh stays open.
//
// Sign-preserving, because another species' trail enters this sum negatively
// (uCross) and v/(1+v/S) has a pole at v = -S.
float saturate1(float v, float k) {
  return sign(v) * abs(v) / (1.0 + abs(v) / k);
}

float senseAt(vec2 pos, vec3 mask) {
  vec2 uv = fract(pos / uGrid);
  float trail = saturate1(dot(texture(uTrail, uv).rgb, mask), uSenseSat);
  return trail + uFoodWeight * texture(uFood, uv).r;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uAgents, uv);
  vec2 pos = s.xy;
  float heading = s.z;
  float species = s.w;
  vec3 mask = speciesMask(species);

  // Local nutrient level sets this agent's gait. Fine mesh where there is
  // food, long strides and long sensors where there is not.
  float food = texture(uFood, fract(pos / uGrid)).r;
  float sensorDist = mix(uSensorDist.y, uSensorDist.x, food);
  float speed = mix(uSpeed.y, uSpeed.x, food);

  float fc = senseAt(pos + vec2(cos(heading), sin(heading)) * sensorDist, mask);
  float hl = heading + uSensorAngle;
  float hr = heading - uSensorAngle;
  float fl = senseAt(pos + vec2(cos(hl), sin(hl)) * sensorDist, mask);
  float fr = senseAt(pos + vec2(cos(hr), sin(hr)) * sensorDist, mask);

  float r = rand(vec3(gl_FragCoord.xy, uStep));
  if (fc > fl && fc > fr) {
    // Straight on -- the case that actually builds a strand.
  } else if (fc < fl && fc < fr) {
    // Both flanks better than ahead: a fork. Choosing randomly rather than
    // taking the stronger one is what makes junctions branch instead of
    // collapsing every agent onto one side.
    heading += (r < 0.5 ? -1.0 : 1.0) * uTurn;
  } else if (fl > fr) {
    heading += uTurn;
  } else if (fr > fl) {
    heading -= uTurn;
  }
  // A little heading noise every step. Without it the network anneals into a
  // near-static lattice after a few minutes, which is exactly what a ten-minute
  // slot must not do.
  heading += (rand(vec3(gl_FragCoord.yx, uStep + 17.0)) - 0.5) * uJitter;
  // Keep the heading bounded. It is integrated forever otherwise, and cos/sin
  // of a few thousand radians loses enough precision in float32 to bias turns.
  heading = mod(heading, TAU);

  pos = mod(pos + vec2(cos(heading), sin(heading)) * speed, uGrid);
  outState = vec4(pos, heading, species);
}`

// Deposit: one additive point per agent into its species' channel.
const DEPOSIT_VERT = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uAgents;
uniform sampler2D uFood;
uniform sampler2D uTrail;
uniform float uSide;
uniform vec2 uGrid;
uniform float uDeposit;
uniform float uBarren;   // deposit multiplier where the field is empty
uniform float uSaturate; // trail level at which deposit is halved
out vec3 vDeposit;

void main() {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec4 s = texture(uAgents, (vec2(float(x), float(y)) + 0.5) / uSide);
  vec2 p = s.xy / uGrid;
  vec3 mask = step(abs(vec3(0.0, 1.0, 2.0) - s.w), vec3(0.5));

  // Deposit saturates against the trail already present.
  //
  // This stands in for the one-agent-per-cell occupancy rule in Jones' original
  // CPU model, which is what stops a path running away with itself. There is no
  // cheap way to test occupancy in a fragment pipeline -- it is a
  // read-modify-write against a map several passes are already reading -- but
  // the trail level is a good proxy for how crowded a cell is, and damping
  // deposit by it has the same effect: the reinforcement loop is sub-linear, so
  // a busy path saturates instead of growing without bound.
  //
  // Without it the frame is a handful of very bright ribbons over a network too
  // faint to see -- a 40x brightness spread across strands that differ only ~4x
  // in traffic. With it the spread is compressed to roughly 2x and the whole
  // network reads at once, which is the canonical physarum look.
  float own = dot(texture(uTrail, p).rgb, mask);
  float crowding = 1.0 / (1.0 + own / uSaturate);

  // Scaling deposit by the nutrient field is what creates negative space: a
  // barren region cannot hold a trail, so it decays to true black and the eye
  // gets somewhere to rest. Not zero, so a strand crossing one stays visible.
  vDeposit = mask * uDeposit * crowding * mix(uBarren, 1.0, texture(uFood, p).r);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`

const DEPOSIT_FRAG = /* glsl */`#version 300 es
precision highp float;
in vec3 vDeposit;
out vec4 outColor;
void main() {
  // Alpha 0 under ONE/ONE blending: the trail's alpha channel is unused, and
  // letting it accumulate a few hundred thousand agent hits per second
  // overflows half-float within minutes.
  outColor = vec4(vDeposit, 0.0);
}`

// Diffuse + decay, the other half of the model.
const DIFFUSE_FRAG = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform float uDecay;
uniform float uDiffuse;
uniform float uFloor;
out vec4 outColor;

vec3 tap(vec2 uv) { return texture(uTrail, fract(uv)).rgb; }

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 c = tap(uv);
  vec3 sum = c;
  sum += tap(uv + vec2(-uTexel.x, 0.0));
  sum += tap(uv + vec2( uTexel.x, 0.0));
  sum += tap(uv + vec2(0.0, -uTexel.y));
  sum += tap(uv + vec2(0.0,  uTexel.y));
  sum += tap(uv + vec2(-uTexel.x, -uTexel.y));
  sum += tap(uv + vec2( uTexel.x, -uTexel.y));
  sum += tap(uv + vec2(-uTexel.x,  uTexel.y));
  sum += tap(uv + vec2( uTexel.x,  uTexel.y));
  vec3 v = mix(c, sum / 9.0, uDiffuse) * uDecay;
  outColor = vec4(max(v - uFloor, 0.0), 1.0);
}`

// Display. Tone-maps the trail (never clamps it) and emits HDR.
const DISPLAY_FRAG = /* glsl */`#version 300 es
precision highp float;
${GLSL.palette}
uniform sampler2D uTrail;
uniform vec2 uResolution;
uniform float uK;
uniform float uGain;
uniform float uGamma;
uniform vec3 uHue;      // one hue, in OKLab turns, per species
uniform float uChroma;
uniform float uLightness;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 t = texture(uTrail, uv).rgb;

  // THE tone-map (issue #91, failure 1). Trail values in a reinforced vein run
  // well past 1.0; clamp() flattens all of them to the same white and the core
  // of the network loses every internal edge. v/(v+K) is unbounded in, [0,1)
  // out, so a vein twice as strong as its neighbour still reads brighter.
  vec3 d = t / (t + vec3(uK));

  vec3 c0 = oklabRamp(0.0, uLightness, uChroma, uHue.x);
  vec3 c1 = oklabRamp(0.0, uLightness, uChroma, uHue.y);
  vec3 c2 = oklabRamp(0.0, uLightness, uChroma, uHue.z);

  // Hue is the density-weighted mix of whichever species are present, so a
  // contact boundary between two networks blends rather than dithering.
  float w = d.r + d.g + d.b;
  vec3 tint = (c0 * d.r + c1 * d.g + c2 * d.b) / max(w, 1e-4);

  float density = max(d.r, max(d.g, d.b));
  // Densest cores desaturate toward white. Real emissive things do this, and
  // it gives the brightest strands somewhere to go once hue is saturated --
  // without it the top of the range is a flat patch of one colour.
  tint = mix(tint, vec3(1.0), smoothstep(0.55, 1.0, density) * 0.55);

  // No lifted background term. Ambient headroom is earned by the strands being
  // genuinely bright (uGain, uLightness), not by tinting black to grey.
  outColor = vec4(tint * pow(density, uGamma) * uGain, 1.0);
}`

// ---------------------------------------------------------------- module

/**
 * Ping-pong pair of RGBA16F colour targets for the trail map.
 *
 * Deliberately not createPingPong, which allocates RGBA32F. The trail is
 * accumulated with additive BLENDING by the deposit pass, and blending into a
 * 32F target requires EXT_float_blend -- an extension that is not universally
 * present, and whose absence would silently disable every deposit. 16F blending
 * is core WebGL2 with EXT_color_buffer_float, has ample range for trail values
 * in the single digits, and is LINEAR-filterable so both the sub-cell sensor
 * lookups and the display upscale sample smoothly.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 * @returns {{read: object, write: object, swap: () => void, destroy: () => void}|null}
 */
function createTrailPair(gl, w, h) {
  const a = createHdrColorTarget(gl, w, h)
  const b = createHdrColorTarget(gl, w, h)
  if (!a || !b) {
    a?.destroy()
    b?.destroy()
    return null
  }
  let front = a, back = b
  for (const t of [a, b]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return {
    get read() { return front },
    get write() { return back },
    swap() { const t = front; front = back; back = t },
    destroy() { a.destroy(); b.destroy() }
  }
}

export default {
  name: 'Physarum',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let foodPass = null, agentPass = null, depositProg = null
    let diffusePass = null, displayPass = null
    let agents = null, trail = null, food = null, vao = null, post = null

    // Resolved in start(), once the drawing buffer has been sized.
    let gridW = 512, gridH = 256
    let foodW = 64, foodH = 32
    let side = 128
    let count = side * side
    let stepAccum = 0
    let stepCount = 0

    // Drawn in create() rather than start() so a start/stop/start cycle keeps
    // the same organism; only a fresh create() picks a new one.
    const rng = createRng(seedValue)

    // The load-bearing choice. The nutrient field decides where the islands
    // are, so without a fresh offset every activation composes identically --
    // same dense patches, same voids, in the same places.
    const fieldOffset = [rng.range(0, 128), rng.range(0, 128)]
    // Nutrient features across the SHORT axis; the field is sampled
    // isotropically, so on the 5:1 wall this multiplies out to roughly 6-9
    // islands across the width. Enough separation that the eye has somewhere to
    // land, not so many that the composition is texture again. It was tried
    // stretched horizontally, which sounds right for a wide frame and is not:
    // it lays the whole network down in horizontal bands.
    const fieldScale = rng.range(1.1, 1.7)
    // Drift. Slow on purpose: one orbit is 4-8 minutes, so a ten-minute slot
    // sees the composition genuinely reorganise without anything visibly moving.
    const fieldOmega = rng.range(0.013, 0.026)
    const fieldRadius = rng.range(0.9, 1.6)
    // Shaping edges. The gap sets how abruptly fertile turns barren; the low
    // edge sets how much of the frame is empty. Kept above 0.4 so a decent
    // fraction of the wall really is black.
    const threshLow = rng.range(0.50, 0.60)
    const threshHigh = threshLow + rng.range(0.09, 0.18)

    // Sensor half-angle and turn angle. Both are tight ranges around the
    // prototype's 0.44 / 0.38 rad: much below ~0.3 the agents cannot resolve a
    // fork and the network smooths into parallel strands, much above ~0.6 they
    // oscillate across their own trail and it thickens into ribbon.
    const sensorAngle = rng.around(0.44, 0.06)
    const turnAngle = rng.around(0.58, 0.07)
    const jitter = rng.range(0.04, 0.09)
    const deposit = rng.around(0.05, 0.008)
    const decay = rng.around(DECAY, 0.012)
    // How much of another species' trail an agent feels. Negative = avoidance,
    // which is what produces territories and visible contact boundaries. Held
    // well short of -1: strong mutual repulsion segregates the frame into three
    // solid blocks and the interleaving that makes it interesting disappears.
    const crossInhibit = rng.range(-0.42, -0.16)
    // Weight on the nutrient field in the sensor sum. Comparable to a trail
    // value so it steers migration, not so large that it overrides the trail
    // and turns the agents into a plain gradient-follower with no network.
    const foodWeight = rng.range(0.05, 0.11)
    const barrenDeposit = rng.range(0.01, 0.045)

    const speciesCount = rng.chance(0.7) ? 3 : 2
    const spread = rng.pick(HUE_SPREADS)
    const hueBase = rng.next()
    const hues = spread.map((h) => hueBase + h)
    const chroma = rng.range(0.10, 0.15)

    /**
     * Initial agent state.
     *
     * Species are assigned by nearest anchor rather than at random per agent.
     * Random assignment mixes all three uniformly, and because cross-inhibition
     * only acts locally they then interleave at the filament scale and the
     * frame averages to one colour at any distance. Anchors give each species
     * a starting territory, so the colour reads at wall scale; the territories
     * then migrate and tangle on their own.
     */
    function seedAgents() {
      const anchorCount = speciesCount * 3
      const anchors = []
      for (let i = 0; i < anchorCount; i++) {
        anchors.push([rng.next() * gridW, rng.next() * gridH, i % speciesCount])
      }
      const data = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const x = rng.next() * gridW
        const y = rng.next() * gridH
        let best = 0, bestD = Infinity
        for (let a = 0; a < anchors.length; a++) {
          // Toroidal distance -- the grid wraps, so a plain difference would
          // make agents next to the seam pick a far anchor.
          let dx = Math.abs(x - anchors[a][0])
          let dy = Math.abs(y - anchors[a][1])
          if (dx > gridW / 2) dx = gridW - dx
          if (dy > gridH / 2) dy = gridH - dy
          const d = dx * dx + dy * dy
          if (d < bestD) { bestD = d; best = anchors[a][2] }
        }
        data[i * 4 + 0] = x
        data[i * 4 + 1] = y
        data[i * 4 + 2] = rng.angle()
        data[i * 4 + 3] = best
      }
      return data
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        if (!gl.getExtension('EXT_color_buffer_float')) {
          throw new Error('Physarum needs EXT_color_buffer_float for the trail map')
        }
        gl.getExtension('OES_texture_float_linear')

        // Size the backing store BEFORE anything reads canvas.width.
        // createGLRuntime does not do this -- it only wires up the context, and
        // the drawing-buffer size is first set inside runtime.start()'s loop.
        // Until then a canvas that has only been sized in CSS still reports the
        // HTML default 300x150, which here meant a 136x68 trail grid on a 5:1
        // wall: agents at 44% of cells instead of 11%, so the network collapsed
        // into saturated blobs. Every size below is derived from these numbers,
        // so this line has to come first.
        runtime.resize()

        // Grid derived from the canvas, so cells stay the same physical size on
        // any display and the trail texture matches the canvas aspect exactly
        // (the display pass can then map uv 1:1 with no letterboxing).
        const px = cellPx(canvas)
        gridW = Math.max(64, Math.round(canvas.width / px))
        gridH = Math.max(64, Math.round(canvas.height / px))
        const cells = gridW * gridH
        if (cells > MAX_TRAIL_CELLS) {
          const k = Math.sqrt(MAX_TRAIL_CELLS / cells)
          gridW = Math.max(64, Math.round(gridW * k))
          gridH = Math.max(64, Math.round(gridH * k))
        }
        foodW = Math.max(16, Math.round(gridW / FOOD_DIV))
        foodH = Math.max(16, Math.round(gridH / FOOD_DIV))

        // Agent count tracks grid area, so density -- and therefore how the
        // network looks -- is the same on a laptop and on the wall.
        side = Math.round(Math.sqrt(gridW * gridH * AGENT_FRACTION) / 8) * 8
        side = Math.max(MIN_AGENT_SIDE, Math.min(MAX_AGENT_SIDE, side))
        count = side * side

        agents = createPingPong(gl, side, side, seedAgents())
        trail = createTrailPair(gl, gridW, gridH)
        if (!trail) throw new Error('Physarum could not allocate its trail map')
        food = createHdrColorTarget(gl, foodW, foodH)
        if (!food) throw new Error('Physarum could not allocate its nutrient field')

        foodPass = createFullscreenPass(gl, FOOD_FRAG)
        agentPass = createFullscreenPass(gl, AGENT_FRAG)
        depositProg = buildProgram(gl, DEPOSIT_VERT, DEPOSIT_FRAG)
        diffusePass = createFullscreenPass(gl, DIFFUSE_FRAG)
        displayPass = createFullscreenPass(gl, DISPLAY_FRAG)
        vao = gl.createVertexArray()

        const uFood = createUniformCache(gl, foodPass.program)
        const uAgent = createUniformCache(gl, agentPass.program)
        const uDep = createUniformCache(gl, depositProg.program)
        const uDiff = createUniformCache(gl, diffusePass.program)
        const uDisp = createUniformCache(gl, displayPass.program)

        const lum = luminanceScale(canvas)
        // Threshold sits below the brightest strands but above the diffusion
        // halo, so only reinforced veins glow. Measured: the display pass peaks
        // around GAIN (2.6) in a dense core and sits near 0.3-0.6 in the haze.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 1.15 * lum, knee: 0.5, intensity: 0.3, radius: 1.0 },
          tonemap: 'aces',
          dither: true
        })

        stepAccum = 0
        stepCount = 0

        runtime.start((time, frameCount, glCtx, rt) => {
          gl.disable(gl.BLEND)

          // Nutrient field first: the agent, deposit and (indirectly) display
          // passes all read it, and it must be coherent across the substeps.
          gl.bindFramebuffer(gl.FRAMEBUFFER, food.fbo)
          gl.viewport(0, 0, foodW, foodH)
          foodPass.draw((g) => {
            g.uniform2f(uFood('uTexel'), 1 / foodW, 1 / foodH)
            g.uniform2f(uFood('uOffset'), fieldOffset[0], fieldOffset[1])
            g.uniform1f(uFood('uScale'), fieldScale)
            g.uniform1f(uFood('uAspect'), gridW / gridH)
            g.uniform1f(uFood('uTime'), time)
            g.uniform1f(uFood('uOmega'), fieldOmega)
            g.uniform1f(uFood('uRadius'), fieldRadius)
            g.uniform2f(uFood('uThreshold'), threshLow, threshHigh)
          })

          // Wall-clock stepping, capped. See STEP_HZ.
          stepAccum += rt.dt
          let steps = Math.floor(stepAccum * STEP_HZ)
          if (steps > MAX_STEPS_PER_FRAME) {
            steps = MAX_STEPS_PER_FRAME
            stepAccum = 0
          } else {
            stepAccum -= steps / STEP_HZ
          }
          // Always advance on the very first frame, so a capture taken
          // immediately after start() is not a black screen.
          if (frameCount === 0) steps = Math.max(steps, 1)

          for (let i = 0; i < steps; i++) {
            stepCount++

            // 1. Agents sense and move.
            gl.bindFramebuffer(gl.FRAMEBUFFER, agents.write.fbo)
            gl.viewport(0, 0, side, side)
            agentPass.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, agents.read.tex)
              g.activeTexture(g.TEXTURE1)
              g.bindTexture(g.TEXTURE_2D, trail.read.tex)
              g.activeTexture(g.TEXTURE2)
              g.bindTexture(g.TEXTURE_2D, food.tex)
              g.uniform1i(uAgent('uAgents'), 0)
              g.uniform1i(uAgent('uTrail'), 1)
              g.uniform1i(uAgent('uFood'), 2)
              g.uniform2f(uAgent('uTexel'), 1 / side, 1 / side)
              g.uniform2f(uAgent('uGrid'), gridW, gridH)
              g.uniform1f(uAgent('uSensorAngle'), sensorAngle)
              g.uniform1f(uAgent('uTurn'), turnAngle)
              g.uniform2f(uAgent('uSensorDist'), SENSOR_NEAR, SENSOR_FAR)
              g.uniform2f(uAgent('uSpeed'), SPEED_NEAR, SPEED_FAR)
              g.uniform1f(uAgent('uCross'), crossInhibit)
              g.uniform1f(uAgent('uFoodWeight'), foodWeight)
              g.uniform1f(uAgent('uJitter'), jitter)
              g.uniform1f(uAgent('uSenseSat'), SENSE_SAT)
              g.uniform1f(uAgent('uStep'), stepCount)
            })
            agents.swap()

            // 2. Diffuse and decay. This runs BEFORE the deposit, not after,
            // and the order is load-bearing: the deposit pass has to sample the
            // trail (for its crowding term) while rendering into it, and a draw
            // that reads its own colour attachment is undefined in GL -- in
            // practice the whole frame came out black. Diffusing first and
            // swapping leaves the previous, now-inactive buffer available to
            // sample, so the two are different textures.
            gl.bindFramebuffer(gl.FRAMEBUFFER, trail.write.fbo)
            gl.viewport(0, 0, gridW, gridH)
            diffusePass.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, trail.read.tex)
              g.uniform1i(uDiff('uTrail'), 0)
              g.uniform2f(uDiff('uTexel'), 1 / gridW, 1 / gridH)
              g.uniform1f(uDiff('uDecay'), decay)
              g.uniform1f(uDiff('uDiffuse'), DIFFUSE)
              g.uniform1f(uDiff('uFloor'), TRAIL_FLOOR)
            })
            trail.swap()

            // 3. Deposit additively into the freshly diffused trail, reading
            // crowding from the pre-diffusion copy left in trail.write.
            gl.bindFramebuffer(gl.FRAMEBUFFER, trail.read.fbo)
            gl.viewport(0, 0, gridW, gridH)
            gl.enable(gl.BLEND)
            gl.blendFunc(gl.ONE, gl.ONE)
            gl.useProgram(depositProg.program)
            gl.bindVertexArray(vao)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, agents.read.tex)
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, food.tex)
            gl.activeTexture(gl.TEXTURE2)
            gl.bindTexture(gl.TEXTURE_2D, trail.write.tex)
            gl.uniform1i(uDep('uAgents'), 0)
            gl.uniform1i(uDep('uFood'), 1)
            gl.uniform1i(uDep('uTrail'), 2)
            gl.uniform1f(uDep('uSide'), side)
            gl.uniform2f(uDep('uGrid'), gridW, gridH)
            gl.uniform1f(uDep('uDeposit'), deposit)
            gl.uniform1f(uDep('uBarren'), barrenDeposit)
            gl.uniform1f(uDep('uSaturate'), SATURATE)
            gl.drawArrays(gl.POINTS, 0, count)
            gl.disable(gl.BLEND)
          }

          // 4. Display, into the HDR chain.
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)
          displayPass.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, trail.read.tex)
            g.uniform1i(uDisp('uTrail'), 0)
            g.uniform2f(uDisp('uResolution'), canvas.width, canvas.height)
            g.uniform1f(uDisp('uK'), K_TONEMAP)
            g.uniform1f(uDisp('uGain'), GAIN * lum)
            g.uniform1f(uDisp('uGamma'), DENSITY_GAMMA)
            g.uniform3f(uDisp('uHue'), hues[0], hues[1], hues[2])
            g.uniform1f(uDisp('uChroma'), chroma)
            g.uniform1f(uDisp('uLightness'), SPECIES_LIGHTNESS)
          })
          gl.activeTexture(gl.TEXTURE0)

          if (post) post.present()
        })
      },
      stop() {
        if (foodPass) { foodPass.destroy(); foodPass = null }
        if (agentPass) { agentPass.destroy(); agentPass = null }
        if (depositProg) { depositProg.destroy(); depositProg = null }
        if (diffusePass) { diffusePass.destroy(); diffusePass = null }
        if (displayPass) { displayPass.destroy(); displayPass = null }
        if (vao) { gl.deleteVertexArray(vao); vao = null }
        if (agents) { agents.destroy(); agents = null }
        if (trail) { trail.destroy(); trail = null }
        if (food) { food.destroy(); food = null }
        if (post) { post.destroy(); post = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
