// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Pong — two AI paddles playing each other forever inside a CRT arcade cabinet
 * (issues #58, #179).
 *
 * Unlike every other saver in the set this one has real game state, so the
 * simulation lives in JS and only the drawing is on the GPU. The state is small
 * (two paddles, a ball, two scores) and is passed as uniforms each frame.
 *
 * **The AI has to be imperfect on purpose.** A paddle that tracks the ball's y
 * exactly never misses, the score never changes, and the rally continues
 * forever -- which reads as a screensaver that has frozen. Each paddle instead
 * gets a reaction delay, a target error that is re-rolled per rally, and a
 * maximum speed that caps how far it can travel, so points are genuinely won
 * and lost. See AI_PROFILES for how those interact. That model is reproduced
 * verbatim in test/pong-ai.test.js and is deliberately untouched by the #179
 * rework: nothing below changes a single physics constant or code path, so the
 * measured scoring cadence (one point per 28-69s) is preserved exactly.
 *
 * WHAT #179 CHANGED: THE PRESENTATION, NOT THE GAME
 *
 * The old version stretched the court across the whole canvas. On a 6000x1200
 * videowall that put the two paddles 5460px apart at the extreme edges with
 * nothing at all in the middle 80% of the frame -- "two slivers and a dot". A
 * 5:1 canvas is not a wider Pong table, it is a room with a cabinet in it.
 *
 * So the court is now letterboxed into a 16:9 CRT tube in the centre, and the
 * width either side of it is a cabinet with a large scoreboard on each panel.
 * Three passes:
 *
 *   1. COURT_FRAG  -> a fixed 640x360 HDR target, ping-ponged with itself so
 *                     the previous frame decays underneath the new one. That
 *                     is the phosphor: a real accumulation buffer, not a fake
 *                     smear, and it is what gives the ball its trail.
 *   2. TUBE_FRAG   -> the canvas-sized HDR scene target. Magnifies the court
 *                     through a barrel warp with scanlines and an aperture
 *                     grille, then draws the bezel, the cabinet, the panel
 *                     scoreboards and the light the screen spills onto them.
 *   3. post-fx     -> halation bloom, ACES, dither (#112). The tube pass
 *                     writes genuine HDR (bright cores run to ~4.0) so the
 *                     bloom has something to find -- see #140 for the bug
 *                     where a saver tonemapped before the chain and bloomed
 *                     nothing.
 *
 * Rendering the court at a fixed 640x360 rather than at canvas resolution is
 * deliberate and is most of the "1972" of the look: the ball is a 5px square
 * that gets magnified 2.8x on the wall, so it has soft phosphor edges instead
 * of a crisp SDF outline, the scanline pitch means something, and the cost of
 * the accumulation is constant regardless of how big the wall is.
 *
 * Per-activation variation: paddle skill, ball speed, serve direction, phosphor
 * colour and cabinet grain.
 */
import { createGLRuntime, createFullscreenPass, createHdrColorTarget, luminanceScale } from './gl-base.js'
import { createUniformCache } from './glsl-lib.js'
import { createPostChain } from './post-fx.js'
import { createRng } from './seed.js'

// ---------------------------------------------------------------------------
// Simulation constants. UNCHANGED from the original -- test/pong-ai.test.js
// mirrors every one of these and asserts the scoring cadence against them.
// ---------------------------------------------------------------------------

// Play field is normalised: x in [0,1], y in [0,1]. The shader maps this into
// the court rectangle.
const PADDLE_X = 0.045          // distance of each paddle from its wall
const PADDLE_H = 0.17           // paddle height as a fraction of court height
const PADDLE_W = 0.011
const BALL_R = 0.011

// Ball speed in court-widths per second. Rallies speed the ball up slightly so
// a long rally does not become tedious, capped so it stays trackable.
const BALL_SPEED_BASE = 0.42
const BALL_SPEED_MAX = 0.85
const RALLY_SPEEDUP = 1.035

// How wrong each paddle is willing to be. `error` is the offset it aims for
// relative to the ball's true arrival y, re-rolled per rally; `reaction` is how
// long it waits before it starts tracking a new ball direction; `maxSpeed`
// caps travel so a large error cannot be corrected at the last moment.
//
// These values are measured, not guessed. A paddle saves the ball when it is
// within PADDLE_H/2 + BALL_R = 0.096 of it, so an aim error below that can
// never cause a miss on its own, and a maxSpeed high enough to cross the court
// within the ball's flight time makes the reaction delay irrelevant too.
//
// The first attempt here (error 0.055-0.140, maxSpeed 0.60-0.90) had both
// problems: simulating 5 minutes of every matchup scored ZERO points in
// sharp-vs-sharp and sloppy-vs-sloppy, because a paddle could traverse the
// whole court in the 1.07-2.17s the ball needed to cross. A frozen scoreboard
// is exactly the "screensaver has crashed" look the issue warns about.
//
// These were chosen by simulating all six matchups x 3 seeds x 5 minutes: every
// pairing now scores, at roughly one point per 28-69 seconds.
const AI_PROFILES = [
  { error: 0.12, reaction: 0.20, maxSpeed: 0.38 },  // sharp
  { error: 0.17, reaction: 0.28, maxSpeed: 0.32 },  // average
  { error: 0.23, reaction: 0.36, maxSpeed: 0.27 }   // sloppy
]

const SCORE_LIMIT = 11
// Pause after a point, so the score change is readable before the next serve.
const SERVE_DELAY = 1.1

// ---------------------------------------------------------------------------
// Presentation constants.
// ---------------------------------------------------------------------------

// Phosphor accumulation target. 640x360 is 16:9 to match the tube, low enough
// that the ball is a chunky few pixels (authentic, and it is what makes the
// magnified edges soft rather than vector-sharp), and high enough that the
// 7-segment score inside the tube still resolves. Fixed rather than canvas-
// derived so the look and the cost are identical at 1080p and at 6000x1200.
const COURT_W = 640
const COURT_H = 360
const COURT_ASPECT = COURT_W / COURT_H

// Ball drawn slightly larger than its collision radius, and square. The
// original's ball was a square roughly the width of a paddle; at 0.011 the
// physics radius alone renders as an 8px dot on the wall, which reads as a
// speck. Drawing at 0.014 does not touch the collision test, so the scoring
// cadence the AI profiles were tuned for is bit-identical.
const BALL_DRAW = 0.014

// Phosphor half-life, in seconds, at the slowest and fastest ball speeds. The
// trail is a decay of the whole accumulation buffer, so this is also how long
// a paddle smears for. 0.055s is about three frames at 60Hz -- enough to read
// as a trail, short enough that the court does not turn to soup. The upper
// bound is the issue's "longer as the ball speeds up" cue; past ~0.15s the
// trail starts to close the gap between the paddles and the game gets hard to
// read.
const TRAIL_HALFLIFE_SLOW = 0.055
const TRAIL_HALFLIFE_FAST = 0.130

// How long the impact effects last. Squash is short and snappy (a paddle that
// stays deformed looks broken); the spark outlives it slightly so the eye
// catches the contact point after the ball has left.
const SQUASH_DECAY = 7.0        // per second, exponential
const SPARK_DECAY = 5.5
const SHAKE_DECAY = 6.5

// Rally length at which "heat" saturates. Rallies of 14+ hits are the ones
// worth acknowledging; below that the ramp is gentle enough not to flicker.
const HEAT_RALLY_FULL = 14

// Number of impact sparks alive at once. Three covers a paddle hit landing
// while the previous one is still visible; more is invisible and costs
// uniforms.
const MAX_SPARKS = 3

// -------------------------------------------------------------- shared GLSL

// Signed distance to an axis-aligned box, and its rounded variant (Quilez).
const SDF_GLSL = /* glsl */ `
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// Distance to a capsule, used to draw the ball swept between two frames.
// Without this the ball is a dotted line whenever the frame rate drops, since
// at 10fps it moves eight times its own width between samples.
float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
`

// 7-segment digits. Cheaper and crisper at wall scale than a font texture, and
// the score is the only text this saver needs. The encoding is verified
// against a capture of the original hardware -- "4" and "2" render correctly.
//
// Segment order (bit 0 upward): top, top-left, top-right, middle, bottom-left,
// bottom-right, bottom. `segments` takes the mask directly so the same code can
// draw the unlit segments of a physical readout (mask 127) as well as a digit.
const DIGIT_GLSL = /* glsl */ `
int digitMask(int n) {
  int masks[10];
  masks[0] = 119; masks[1] = 36;  masks[2] = 93;  masks[3] = 109; masks[4] = 46;
  masks[5] = 107; masks[6] = 123; masks[7] = 37;  masks[8] = 127; masks[9] = 111;
  return masks[n];
}

float segments(vec2 p, int m) {
  float d = 1e9;
  float t = 0.055;   // segment thickness, in digit-local units
  if ((m & 1) != 0)  d = min(d, sdBox(p - vec2(0.0,  0.34), vec2(0.16, t)));
  if ((m & 8) != 0)  d = min(d, sdBox(p - vec2(0.0,  0.00), vec2(0.16, t)));
  if ((m & 64) != 0) d = min(d, sdBox(p - vec2(0.0, -0.34), vec2(0.16, t)));
  if ((m & 2) != 0)  d = min(d, sdBox(p - vec2(-0.18,  0.17), vec2(t, 0.17)));
  if ((m & 4) != 0)  d = min(d, sdBox(p - vec2( 0.18,  0.17), vec2(t, 0.17)));
  if ((m & 16) != 0) d = min(d, sdBox(p - vec2(-0.18, -0.17), vec2(t, 0.17)));
  if ((m & 32) != 0) d = min(d, sdBox(p - vec2( 0.18, -0.17), vec2(t, 0.17)));
  return d;
}
`

// ------------------------------------------------------------- court shader

/**
 * Pass 1: the raster inside the tube, accumulated into a phosphor buffer.
 *
 * Everything is drawn as a scalar "beam energy" rather than as colour, and
 * tinted once at the end. That is how a monochrome CRT actually works, and it
 * buys the highlight behaviour for free: the tint function whitens as energy
 * rises, so a hot ball core goes white-hot while its halo stays the phosphor
 * colour, instead of the whole frame being one flat amber.
 */
const COURT_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform float uKeep;          // fraction of the previous frame to retain
uniform vec2 uBall;           // court coords, this frame
uniform vec2 uBallPrev;       // court coords, previous frame (motion blur)
uniform float uPaddleL;
uniform float uPaddleR;
uniform vec2 uSquash;         // 0..1 per paddle, decays after a hit
uniform vec4 uScore;          // xy = left digits, zw = right digits (tens, ones)
uniform float uFlash;         // 0..1, brief flash on the wall that conceded
uniform float uFlashSide;     // -1 left, +1 right
uniform vec3 uSparks[${MAX_SPARKS}];   // xy = court coords, z = intensity
uniform float uSpeed;         // 0..1, ball speed within its range
uniform vec3 uTint;
out vec4 fragColor;

${SDF_GLSL}
${DIGIT_GLSL}

void main() {
  // Court space: one unit of y equals one unit of x visually, so the ball and
  // paddles are square whatever the tube's pixel aspect.
  vec2 uv = gl_FragCoord.xy / vec2(${COURT_W}.0, ${COURT_H}.0);
  vec2 p = vec2(uv.x * ${COURT_ASPECT}, uv.y);
  float A = ${COURT_ASPECT};

  // Beam energy, HDR. 1.0 is "a lit pixel"; cores go well past it so the post
  // chain's bright pass has something genuine to pick up.
  float e = 0.0;

  // Court boundary rails, top and bottom. The original had them and they are
  // what stops the play area reading as an unbounded void. Sat right at the
  // raster edge, where the ball bounces, rather than inset -- inset rails read
  // as a second court the ball passes through.
  {
    float d = min(abs(p.y - 0.008), abs(p.y - 0.992));
    e += 1.0 * smoothstep(0.009, 0.0, d);
  }

  // Centre net: a dashed vertical line.
  {
    float dash = step(0.42, fract(uv.y * 26.0));
    float d = abs(p.x - 0.5 * A);
    e += 0.55 * dash * smoothstep(0.006, 0.0, d);
  }

  // Paddles. A hit squashes the struck paddle along its long axis and bulges
  // it along the short one, conserving area so it reads as compression rather
  // than as the paddle changing size.
  {
    float hw = ${PADDLE_W}, hh = ${PADDLE_H} * 0.5;
    vec2 bl = vec2(hw * (1.0 + 0.85 * uSquash.x), hh * (1.0 - 0.28 * uSquash.x));
    vec2 br = vec2(hw * (1.0 + 0.85 * uSquash.y), hh * (1.0 - 0.28 * uSquash.y));
    float dl = sdBox(p - vec2(${PADDLE_X} * A, uPaddleL), bl);
    float dr = sdBox(p - vec2((1.0 - ${PADDLE_X}) * A, uPaddleR), br);
    float d = min(dl, dr);
    e += 2.3 * smoothstep(0.004, 0.0, d);
    // Bloom-ish local halo. Deliberately tight: the wide glow is the job of the
    // post chain, this only softens the hard SDF edge into the phosphor.
    e += 0.5 * exp(-max(d, 0.0) * 70.0);
  }

  // Ball, swept from its previous position so a long frame leaves a streak
  // rather than a gap. Brightness and halo both rise with speed: on a CRT a
  // faster beam is dimmer, but here the speed cue matters more than the physics
  // and a hot ball is what sells a fast rally.
  {
    float r = ${BALL_DRAW};
    vec2 a = vec2(uBallPrev.x * A, uBallPrev.y);
    vec2 b = vec2(uBall.x * A, uBall.y);
    float d = sdSegment(p, a, b, r);
    e += (3.4 + 2.6 * uSpeed) * smoothstep(0.005, 0.0, d);
    e += (0.9 + 0.8 * uSpeed) * exp(-max(d, 0.0) * 42.0);
  }

  // Impact sparks: a short bright burst at the contact point. Small radius and
  // high amplitude, so what the eye actually sees is the bloom around it.
  for (int i = 0; i < ${MAX_SPARKS}; i++) {
    vec3 s = uSparks[i];
    if (s.z <= 0.002) continue;
    float d = length(p - vec2(s.x * A, s.y));
    e += s.z * 5.0 * exp(-d * 130.0);
  }

  // Score inside the tube, where the original put it. It is no longer the only
  // scoreboard -- the cabinet panels carry the legible one -- so this can stay
  // period-correct without having to be readable from across a room.
  {
    float sy = 0.80;
    float scale = 0.155;
    vec2 lp = (p - vec2(0.5 * A - 0.17, sy)) / scale;
    vec2 rp = (p - vec2(0.5 * A + 0.17, sy)) / scale;
    float d = 1e9;
    // Tens digit only when non-zero, so single-digit scores stay centred.
    if (uScore.x > 0.5) d = min(d, segments(lp + vec2(0.40, 0.0), digitMask(int(uScore.x))));
    d = min(d, segments(lp - vec2(0.40, 0.0) * step(0.5, uScore.x), digitMask(int(uScore.y))));
    if (uScore.z > 0.5) d = min(d, segments(rp + vec2(0.40, 0.0), digitMask(int(uScore.z))));
    d = min(d, segments(rp - vec2(0.40, 0.0) * step(0.5, uScore.z), digitMask(int(uScore.w))));
    e += 0.95 * smoothstep(0.006, 0.0, d);
  }

  // Flash down the wall that just conceded, so a point registers even if you
  // were not watching the ball.
  if (uFlash > 0.001) {
    float wallX = uFlashSide < 0.0 ? 0.0 : A;
    e += uFlash * 1.6 * exp(-abs(p.x - wallX) * 9.0);
  }

  // Phosphor tint. Whitening with energy is what keeps a hot core from being a
  // saturated amber blob: real phosphor saturates toward white when driven hard.
  vec3 cur = mix(uTint, vec3(1.0), clamp(e * 0.16, 0.0, 0.7)) * e;

  // Persistence. max() rather than a blend, so a static element sits at exactly
  // its intended brightness no matter what the frame rate is, while everything
  // that moved decays behind it at uKeep per frame. A plain accumulate would
  // make the steady-state brightness a function of refresh rate -- 1.7x at the
  // 10fps of the headless harness against 7.4x at 60Hz.
  vec3 prev = texture(uPrev, uv).rgb * uKeep;
  fragColor = vec4(max(cur, prev), 1.0);
}
`

// -------------------------------------------------------------- tube shader

/**
 * Pass 2: the cabinet.
 *
 * Coordinates are "unit space": y in [-0.5, 0.5] over the canvas height, x in
 * [-A/2, A/2]. Distances are therefore comparable on both axes and independent
 * of resolution, which is what lets one layout rule cover 16:9 and 5:1.
 *
 * The scanline and mask pitches are the exception: those are in *device* pixels
 * on purpose. A mask defined in unit space would become a fine shimmer on the
 * wall and a coarse stripe on a laptop; the artefact being simulated is a
 * property of the display's own pixel grid, so it is measured in those.
 */
const TUBE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uAccum;
uniform vec3 uTint;
uniform float uLumaScale;
uniform float uTime;
uniform vec4 uScore;          // xy = left digits, zw = right digits (tens, ones)
uniform vec2 uPanelFlash;     // 0..1 per side, decays after that side scores
uniform vec2 uMatchPoint;     // 1.0 when that side is on 10
uniform float uSpill;         // 0..1, how hard the screen is lighting the room
uniform float uBallLean;      // -1..1, ball x, so the spill leans with the play
uniform float uHeat;          // 0..1, rally intensity
uniform vec2 uShake;          // x = amplitude in screen heights, y = phase time
uniform vec4 uSeed;           // per-activation randoms, for the cabinet grain
out vec4 fragColor;

${SDF_GLSL}
${DIGIT_GLSL}

// Lottes-style barrel warp. Small values: this is a 1980s arcade monitor, not a
// 1950s television, and anything stronger fights the letterboxing by pushing
// the paddles back toward the tube edges.
vec2 warp(vec2 uv, vec2 amount) {
  uv = uv * 2.0 - 1.0;
  uv *= vec2(1.0 + (uv.y * uv.y) * amount.x, 1.0 + (uv.x * uv.x) * amount.y);
  return uv * 0.5 + 0.5;
}

// Magnifying sample of the phosphor buffer. Plain LINEAR turns a 5px ball into
// a wide smudge; smoothstepping the sub-texel fraction keeps a soft but
// definite edge, which is the standard trick for scaling a low-res raster
// without either blur or blockiness.
vec3 sampleCourt(vec2 uv) {
  vec2 texel = vec2(${COURT_W}.0, ${COURT_H}.0);
  vec2 t = uv * texel - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  f = f * f * (3.0 - 2.0 * f);
  return texture(uAccum, (i + f + 0.5) / texel).rgb;
}

// One glowing 7-segment readout with its unlit segments faintly visible, which
// is what makes it read as a physical display rather than as floating digits.
// A tens value below 0.5 hides the leading digit and centres the ones digit.
float readout(vec2 p, float tens, float ones, out float ghost) {
  float gap = 0.36;
  float lit = 1e9;
  float all = 1e9;
  if (tens > 0.5) {
    lit = min(lit, segments(p + vec2(gap, 0.0), digitMask(int(tens))));
    all = min(all, segments(p + vec2(gap, 0.0), 127));
  }
  vec2 q = p - vec2(gap, 0.0) * step(0.5, tens);
  lit = min(lit, segments(q, digitMask(int(ones))));
  all = min(all, segments(q, 127));
  ghost = all;
  return lit;
}

void main() {
  vec2 res = uResolution;
  float A = res.x / res.y;
  // Unit space, y in [-0.5, 0.5].
  vec2 q = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float px = 1.0 / res.y;          // one device pixel, in unit space

  // ---- tube geometry -------------------------------------------------------
  // The tube is a fixed fraction of the canvas HEIGHT, so it letterboxes on a
  // wide canvas instead of stretching. The width term only bites on canvases
  // narrower than 16:9, where the tube shrinks to stay inside the frame.
  float tubeH = min(0.84, A * 0.94 / ${COURT_ASPECT});
  vec2 tubeHalf = vec2(tubeH * ${COURT_ASPECT}, tubeH) * 0.5;
  float bezelW = 0.030;
  float dTube = sdRoundBox(q, tubeHalf, 0.030);

  // ---- cabinet -------------------------------------------------------------
  // Never pure black (#88), but only just: the tube has to be the brightest
  // thing in the frame or the whole composition inverts and the cabinet reads
  // as the subject. A dark COOL surface, lit slightly from above, also gives
  // the warm phosphor something to be warm against.
  //
  // These numbers look absurdly small because they are LINEAR and the post
  // chain gamma-encodes them: 0.005 linear is sRGB 0.10, a clearly visible
  // mid-charcoal. The first pass at this used values an order of magnitude too
  // high and the whole cabinet came out a milky beige.
  float lit = 0.0022 + 0.0035 * smoothstep(-0.55, 0.55, q.y);
  vec3 cabinet = vec3(0.72, 0.82, 1.0) * lit;

  // A single soft catch of light along the top edge. One is enough to say
  // "this is a physical box"; more looks like clip art, and a hard line reads
  // as a rendering seam across 6000px.
  cabinet += vec3(0.8, 0.88, 1.0) * 0.008 * exp(-max(0.5 - q.y, 0.0) * 26.0);

  // Contact shadow under the tube's bezel, so it sits on the cabinet rather
  // than floating over it.
  cabinet *= mix(0.30, 1.0, smoothstep(0.0, 0.10, dTube - bezelW));

  // Cabinet grain. Interleaved-gradient noise at a fraction of a code value:
  // enough to break up a 6000px-wide smooth gradient, far too little to see as
  // texture. The seed keeps two activations from having identical grain.
  {
    vec2 g = gl_FragCoord.xy + uSeed.xy * 512.0;
    float n = fract(52.9829189 * fract(dot(g, vec2(0.06711056, 0.00583715))));
    cabinet += (n - 0.5) * 0.0035;
  }

  // ---- screen spill --------------------------------------------------------
  // The single most important thing on a 5:1 canvas: the tube throws light onto
  // the panels either side, so the whole wall breathes with the game instead of
  // being a bright island in a black field. It leans toward whichever half the
  // ball is in, which is what makes the middle of the wall look *played*.
  {
    float d = max(dTube - bezelW, 0.0);
    // Smooth in q.x, not sign(q.x): a hard sign flip puts a visible vertical
    // seam down the middle of the wall, which was the first thing wrong with
    // this when it was captured at 3000x600.
    float lean = 1.0 + 0.45 * uBallLean * clamp(q.x / max(A * 0.22, 1e-3), -1.0, 1.0);
    float g = exp(-d * 2.4) * uSpill * lean;
    cabinet += uTint * g * 0.125;
  }

  // ---- panel scoreboards ---------------------------------------------------
  // Only drawn when the letterboxing has actually left room. Below that the
  // in-tube score carries it, which is what happens on a 16:9 canvas where the
  // tube nearly fills the frame.
  float gapStart = tubeHalf.x + bezelW;
  float gapEnd = A * 0.5;
  float gapW = gapEnd - gapStart;
  if (gapW > 0.36) {
    float side = q.x < 0.0 ? -1.0 : 1.0;
    float cx = (gapStart + gapEnd) * 0.5;
    // Digit height is 0.8 * scale, so 0.42 gives a 0.34-of-canvas-height digit
    // -- about 400px on the wall, legible the length of a room. Capped against
    // the gap so a merely wide canvas does not run the digits off the edge.
    float scale = min(0.42, gapW * 0.26);
    vec2 sp = (q - vec2(side * cx, 0.055)) / scale;

    float tens = side < 0.0 ? uScore.x : uScore.z;
    float ones = side < 0.0 ? uScore.y : uScore.w;
    float flash = side < 0.0 ? uPanelFlash.x : uPanelFlash.y;
    float mp = side < 0.0 ? uMatchPoint.x : uMatchPoint.y;

    float ghost;
    float d = readout(sp, tens, ones, ghost);
    float aa = px / scale;

    // Recessed housing behind the readout, with a rim. Cheap, and it turns two
    // glowing digits into an instrument on a panel.
    {
      vec2 hb = vec2(0.75, 0.62) * scale;
      float dh = sdRoundBox(q - vec2(side * cx, 0.055), hb, 0.03);
      cabinet *= mix(1.0, 0.55, smoothstep(px * 2.0, 0.0, dh));
      cabinet += vec3(0.8, 0.88, 1.0) * 0.012 * smoothstep(px * 2.5, 0.0, abs(dh) - px);
    }

    // Match point: at 10 the leading readout pulses. The scoring model already
    // produces this moment; nothing used to mark it.
    float pulse = 1.0 + mp * 0.55 * (0.5 + 0.5 * sin(uTime * 5.0));
    float bright = (2.1 + 1.6 * flash) * pulse;

    cabinet += uTint * 0.016 * smoothstep(aa, 0.0, ghost);           // unlit segments
    cabinet += mix(uTint, vec3(1.0), 0.35) * bright * smoothstep(aa, 0.0, d);
    // Tight local halo only. The wide glow is the post chain's bloom; doing it
    // here as well is what made the digits read as soft blobs.
    cabinet += uTint * bright * 0.12 * exp(-max(d, 0.0) * 55.0);

    // Eleven pips: the match is first to 11, and a row of them says so at a
    // glance and pushes content out toward the far edges of the wall, which is
    // otherwise the emptiest part of the frame.
    {
      float span = min(gapW * 0.90, 1.45);
      float score = tens * 10.0 + ones;
      float pitch = span / 10.0;
      vec2 pp = q - vec2(side * cx, -0.30);
      float idx = floor(pp.x / pitch + 5.5);
      float k = clamp(idx, 0.0, 10.0);
      vec2 cp = pp - vec2((k - 5.0) * pitch, 0.0);
      float dp = sdRoundBox(cp, vec2(0.019, 0.013), 0.004);
      float on = step(k, score - 1.0);
      float amt = mix(0.06, 1.5 + mp * 0.8 * (0.5 + 0.5 * sin(uTime * 5.0)), on);
      cabinet += uTint * amt * smoothstep(px * 1.5, 0.0, dp);
    }
  }

  // ---- bezel ---------------------------------------------------------------
  // Dark plastic, lit from the same direction as the cabinet, with a bright
  // inner lip where it catches the screen's own light.
  vec3 bezel = vec3(0.72, 0.80, 1.0) * (0.005 + 0.009 * smoothstep(-0.5, 0.5, q.y));
  bezel += uTint * 0.055 * uSpill * smoothstep(0.014, 0.0, max(dTube, 0.0));
  float bezelMask = smoothstep(bezelW, bezelW - px * 2.0, dTube);
  vec3 outer = mix(cabinet, bezel, bezelMask);

  // ---- screen --------------------------------------------------------------
  vec2 suv = q / tubeHalf * 0.5 + 0.5;
  // Raster shake. Applied to the screen uv rather than to the court content, so
  // the whole image jolts inside a cabinet that stays put -- which is how a
  // deflection knock actually looks, and it keeps the accumulated trail
  // coherent with the frame it belongs to.
  suv += vec2(sin(uShake.y * 61.0), cos(uShake.y * 47.0)) * uShake.x;
  vec2 wuv = warp(suv, vec2(1.0 / 46.0, 1.0 / 30.0));

  vec3 phosphor = sampleCourt(clamp(wuv, 0.0, 1.0));

  // Overscan edge: the raster does not reach the glass.
  float edge = smoothstep(0.0, 0.006, wuv.x) * smoothstep(0.0, 0.006, 1.0 - wuv.x)
             * smoothstep(0.0, 0.004, wuv.y) * smoothstep(0.0, 0.004, 1.0 - wuv.y);
  phosphor *= edge;

  // Scanlines. The pitch is derived from the tube's real device height, floored
  // at 3px so the beam profile is always sampled often enough to be a shape
  // rather than a moire, and capped at the court's own line count so it can
  // never claim more detail than the raster has.
  float tubePx = tubeH * res.y;
  // 4px rather than 3px: at three device pixels per line the fwidth guard below
  // already halves the modulation depth, so the scanlines are present but
  // barely visible. Four gives a full-depth line at every size that ships.
  float pitch = max(4.0, tubePx / float(${COURT_H}));
  float lines = tubePx / pitch;
  float beam = 0.5 + 0.5 * cos(wuv.y * lines * 6.2831853);
  // Fade the modulation out as one scanline approaches one device pixel, which
  // is what stops it crawling on a small preview window.
  float lineW = fwidth(wuv.y) * lines;
  float depth = 0.52 * (1.0 - smoothstep(0.22, 0.5, lineW));
  phosphor *= mix(1.0, beam, depth);

  // Aperture grille. A six-pixel period (two device pixels per phase) is a
  // compromise: three pixels shimmers under any resampling, twelve reads as
  // stripes rather than as a mask.
  {
    float ph = mod(gl_FragCoord.x, 6.0);
    vec3 m = vec3(0.86);
    if (ph < 2.0) m.r = 1.0; else if (ph < 4.0) m.g = 1.0; else m.b = 1.0;
    phosphor *= m;
    // Masks eat light; a real grille tube is driven harder to compensate.
    phosphor *= 1.10;
  }

  // Tube vignette, and the faint grey of unlit glass so the screen is a dark
  // surface rather than a hole.
  vec2 vc = (wuv - 0.5) * 2.0;
  float vig = 1.0 - 0.42 * dot(vc, vc);
  phosphor *= max(vig, 0.0);
  // The bed glow of a lit but idle tube: the glass is never black while the
  // gun is on, and this is what keeps the screen from reading as a hole cut in
  // the cabinet. Rises slightly with how hard the raster is being driven.
  vec3 screen = phosphor + uTint * edge * (0.0060 + 0.0050 * uSpill);

  // Glass: one soft off-axis reflection of a room light, plus a broad sheen.
  // Both are tiny -- the moment a reflection is legible it stops reading as
  // glass and starts reading as a decal.
  {
    vec2 r = (q - vec2(-tubeHalf.x * 0.45, tubeHalf.y * 0.42)) * vec2(1.0, 2.4);
    screen += vec3(0.85, 0.92, 1.0) * 0.009 * exp(-length(r) * 11.0);
    screen += vec3(0.80, 0.88, 1.0) * 0.0025 * smoothstep(0.9, -0.2, q.x * 0.7 - q.y);
  }

  float inScreen = smoothstep(0.0, px * 1.5, -dTube);
  vec3 col = mix(outer, screen, inScreen);

  // Room vignette across the whole wall, biased to the horizontal because that
  // is the axis with 5000px of cabinet on it. Keeps the eye on the tube.
  {
    vec2 v = vec2(q.x / max(A * 0.5, 1e-3), q.y * 2.0);
    col *= 1.0 - 0.30 * dot(v, v);
  }

  // Rally heat: a slow lift of the whole scene as a rally gets long. Subtle by
  // design -- it should be felt rather than noticed.
  col *= 1.0 + 0.12 * uHeat;

  // HDR out. No tonemap, no gamma here: post-fx.js owns both, and doing it
  // twice is issue #140.
  fragColor = vec4(col * uLumaScale, 1.0);
}
`

export default {
  name: 'Pong',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let courtPass = null, tubePass = null, post = null
    let accumA = null, accumB = null

    // RNG in create(), not start(), so the match survives a start/stop cycle.
    const rng = createRng(seedValue)
    const tint = (() => {
      // Real phosphor families rather than arbitrary hues: P4 white-ish, P1
      // green, the amber of a late-70s monitor, and a cold blue-white.
      const options = [
        [0.88, 1.0, 0.90],   // white-green phosphor
        [0.55, 1.0, 0.62],   // green
        [1.0, 0.80, 0.42],   // amber
        [0.62, 0.85, 1.0]    // cold blue
      ]
      return options[rng.int(0, options.length - 1)]
    })()
    const grainSeed = [rng.range(0, 1), rng.range(0, 1), rng.range(0, 1), rng.range(0, 1)]

    const profileL = AI_PROFILES[rng.int(0, AI_PROFILES.length - 1)]
    const profileR = AI_PROFILES[rng.int(0, AI_PROFILES.length - 1)]

    // Game state, all in normalised court coordinates.
    let ball = { x: 0.5, y: 0.5, vx: 0, vy: 0, speed: BALL_SPEED_BASE }
    let padL = 0.5, padR = 0.5
    let targetL = 0.5, targetR = 0.5
    let errL = 0, errR = 0
    let reactL = 0, reactR = 0
    let score = [0, 0]
    let serveTimer = 0
    let flash = 0, flashSide = -1
    let lastTime = 0

    // Presentation state. None of this feeds back into the simulation.
    let ballPrevX = 0.5, ballPrevY = 0.5
    let squashL = 0, squashR = 0
    let shakeAmp = 0, shakeT = 0
    let heat = 0, rallyHits = 0
    let panelFlash = [0, 0]
    let spill = 0
    // Latched per crossing so one miss cannot fire the near-miss cue on every
    // substep the ball spends inside the paddle plane.
    let missLatchL = false, missLatchR = false
    const sparks = Array.from({ length: MAX_SPARKS }, () => ({ x: 0, y: 0, life: 0 }))
    let sparkNext = 0
    const sparkData = new Float32Array(MAX_SPARKS * 3)

    function addSpark(x, y, life) {
      const s = sparks[sparkNext]
      sparkNext = (sparkNext + 1) % MAX_SPARKS
      s.x = x; s.y = y; s.life = life
    }

    function serve(towards) {
      ball.x = 0.5
      ball.y = rng.range(0.35, 0.65)
      ball.speed = BALL_SPEED_BASE
      // Serve angle kept away from horizontal, or the rally is a boring
      // straight line, and away from vertical, or it barely crosses the court.
      const angle = rng.range(0.28, 0.72) * (rng.chance(0.5) ? 1 : -1)
      ball.vx = towards * Math.cos(angle * 0.9)
      ball.vy = Math.sin(angle * 0.9)
      const len = Math.hypot(ball.vx, ball.vy)
      ball.vx /= len; ball.vy /= len
      // Re-roll each paddle's aim error for the new rally, so the same paddle
      // is not wrong in the same direction every time.
      errL = rng.range(-profileL.error, profileL.error)
      errR = rng.range(-profileR.error, profileR.error)
      reactL = profileL.reaction
      reactR = profileR.reaction
      rallyHits = 0
      missLatchL = false
      missLatchR = false
    }

    function resetMatch() {
      score = [0, 0]
      serve(rng.chance(0.5) ? 1 : -1)
      serveTimer = SERVE_DELAY
    }

    /** Advance the game by dt seconds. */
    function update(dt) {
      flash = Math.max(0, flash - dt * 2.2)

      if (serveTimer > 0) {
        serveTimer -= dt
        // Paddles drift back toward centre between points.
        padL += (0.5 - padL) * Math.min(1, dt * 2.2)
        padR += (0.5 - padR) * Math.min(1, dt * 2.2)
        return
      }

      // --- Ball ---
      ball.x += ball.vx * ball.speed * dt
      ball.y += ball.vy * ball.speed * dt

      // Top and bottom walls.
      if (ball.y < BALL_R) {
        ball.y = BALL_R; ball.vy = Math.abs(ball.vy)
        addSpark(ball.x, BALL_R, 0.45); shakeAmp = Math.max(shakeAmp, 0.0012)
      }
      if (ball.y > 1 - BALL_R) {
        ball.y = 1 - BALL_R; ball.vy = -Math.abs(ball.vy)
        addSpark(ball.x, 1 - BALL_R, 0.45); shakeAmp = Math.max(shakeAmp, 0.0012)
      }

      // --- Paddle collisions ---
      // Checked as a crossing rather than an overlap: at high ball speeds a
      // pure overlap test can miss the paddle entirely between two frames and
      // the ball tunnels straight through, which looks like a bug even though
      // the AI was in position.
      const lx = PADDLE_X, rx = 1 - PADDLE_X
      const tolerance = PADDLE_H * 0.5 + BALL_R
      if (ball.vx < 0 && ball.x - BALL_R <= lx + PADDLE_W && ball.x > lx - 0.05) {
        if (Math.abs(ball.y - padL) < tolerance) {
          ball.x = lx + PADDLE_W + BALL_R
          ball.vx = Math.abs(ball.vx)
          // Deflect by where it struck the paddle, so rallies develop angle.
          ball.vy += (ball.y - padL) * 1.9
          ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
          reactR = profileR.reaction
          squashL = 1; rallyHits++
          addSpark(ball.x, ball.y, 1)
          shakeAmp = Math.max(shakeAmp, 0.0035)
        } else if (!missLatchL && Math.abs(ball.y - padL) < tolerance * 1.45) {
          // Near miss: the ball whistled past the paddle's tip. Marked with a
          // spark on the tip rather than with anything that changes the game.
          missLatchL = true
          addSpark(lx + PADDLE_W, padL + Math.sign(ball.y - padL) * PADDLE_H * 0.5, 0.8)
        }
      }
      if (ball.vx > 0 && ball.x + BALL_R >= rx - PADDLE_W && ball.x < rx + 0.05) {
        if (Math.abs(ball.y - padR) < tolerance) {
          ball.x = rx - PADDLE_W - BALL_R
          ball.vx = -Math.abs(ball.vx)
          ball.vy += (ball.y - padR) * 1.9
          ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
          reactL = profileL.reaction
          squashR = 1; rallyHits++
          addSpark(ball.x, ball.y, 1)
          shakeAmp = Math.max(shakeAmp, 0.0035)
        } else if (!missLatchR && Math.abs(ball.y - padR) < tolerance * 1.45) {
          missLatchR = true
          addSpark(rx - PADDLE_W, padR + Math.sign(ball.y - padR) * PADDLE_H * 0.5, 0.8)
        }
      }
      // Renormalise so the deflection changes direction, not speed.
      {
        const len = Math.hypot(ball.vx, ball.vy) || 1
        ball.vx /= len; ball.vy /= len
      }

      // --- Points ---
      if (ball.x < -0.03) {
        score[1]++; flash = 1; flashSide = -1
        panelFlash[1] = 1; shakeAmp = Math.max(shakeAmp, 0.010)
        serveTimer = SERVE_DELAY; serve(-1)
      } else if (ball.x > 1.03) {
        score[0]++; flash = 1; flashSide = 1
        panelFlash[0] = 1; shakeAmp = Math.max(shakeAmp, 0.010)
        serveTimer = SERVE_DELAY; serve(1)
      }
      if (score[0] >= SCORE_LIMIT || score[1] >= SCORE_LIMIT) {
        // Match over: reset so the wall never sits on a finished game.
        resetMatch()
      }

      // --- AI ---
      // Each paddle only tracks once its reaction delay has elapsed, and only
      // when the ball is heading its way. Between times it eases toward the
      // centre, which is both realistic and what creates the openings.
      reactL = Math.max(0, reactL - dt)
      reactR = Math.max(0, reactR - dt)

      targetL = (ball.vx < 0 && reactL <= 0) ? ball.y + errL : 0.5
      targetR = (ball.vx > 0 && reactR <= 0) ? ball.y + errR : 0.5

      const stepL = profileL.maxSpeed * dt
      const stepR = profileR.maxSpeed * dt
      padL += Math.max(-stepL, Math.min(stepL, targetL - padL))
      padR += Math.max(-stepR, Math.min(stepR, targetR - padR))

      const half = PADDLE_H * 0.5
      padL = Math.max(half, Math.min(1 - half, padL))
      padR = Math.max(half, Math.min(1 - half, padR))
    }

    /** Decay the purely visual state. Runs once per frame, not per substep. */
    function updateEffects(dt) {
      const decay = (v, rate) => v * Math.exp(-rate * dt)
      squashL = decay(squashL, SQUASH_DECAY)
      squashR = decay(squashR, SQUASH_DECAY)
      shakeAmp = decay(shakeAmp, SHAKE_DECAY)
      shakeT += dt
      panelFlash[0] = decay(panelFlash[0], 2.4)
      panelFlash[1] = decay(panelFlash[1], 2.4)
      for (const s of sparks) s.life = decay(s.life, SPARK_DECAY)

      // Heat eases toward the rally length so it ramps over a rally instead of
      // stepping on every hit.
      const target = Math.min(1, rallyHits / HEAT_RALLY_FULL)
      heat += (target - heat) * Math.min(1, dt * 1.5)

      // How much light the tube is throwing into the room. A base level so the
      // panels are never unlit, plus the events worth seeing from the far end
      // of the wall.
      const want = 0.55 + 0.35 * heat + 0.9 * flash + 0.5 * Math.max(panelFlash[0], panelFlash[1])
      spill += (want - spill) * Math.min(1, dt * 6.0)
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl

        courtPass = createFullscreenPass(gl, COURT_FRAG)
        tubePass = createFullscreenPass(gl, TUBE_FRAG)
        const uc = createUniformCache(gl, courtPass.program)
        const ut = createUniformCache(gl, tubePass.program)

        // Phosphor buffers. RGBA16F and LINEAR-filterable, because the tube
        // pass magnifies them; a NEAREST simulation target would be the wrong
        // tool here (see createHdrColorTarget's note).
        accumA = createHdrColorTarget(gl, COURT_W, COURT_H)
        accumB = createHdrColorTarget(gl, COURT_W, COURT_H)
        let read = accumA, write = accumB
        if (accumA && accumB) {
          for (const t of [accumA, accumB]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
            gl.clearColor(0, 0, 0, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        }

        // Threshold sits just under the scanline-and-mask-attenuated paddle
        // brightness (2.3 * ~0.5 * 1.18 ~ 1.35) so paddles halate gently while
        // the ball core, at three times that, blooms hard. Radius is generous:
        // halation on a CRT is a wide, soft glow in the glass, not a tight
        // Gaussian.
        post = createPostChain(gl, canvas, {
          bloom: { threshold: 0.70, knee: 0.40, intensity: 0.90, radius: 1.05 },
          tonemap: 'aces',
          dither: true,
        })

        resetMatch()
        lastTime = 0
        ballPrevX = ball.x
        ballPrevY = ball.y

        runtime.start((time) => {
          // Fixed-step integration. A variable dt straight from the frame clock
          // makes collision response frame-rate dependent -- at a long frame
          // the ball can jump past a paddle. Clamped so a stall does not spend
          // a whole frame catching up.
          const raw = lastTime === 0 ? 0 : Math.min(time - lastTime, 0.25)
          lastTime = time
          const STEP = 1 / 120
          let remaining = raw
          let guard = 64
          const startX = ball.x, startY = ball.y
          while (remaining > 0 && guard-- > 0) {
            const dt = Math.min(STEP, remaining)
            update(dt)
            remaining -= dt
          }
          updateEffects(raw)

          // Sweep endpoints for the motion-blurred ball. Suppressed across a
          // serve, or the streak would be drawn from wherever the point ended
          // back to the centre spot.
          const jumped = Math.abs(ball.x - startX) > 0.2
          ballPrevX = jumped ? ball.x : startX
          ballPrevY = jumped ? ball.y : startY

          const speedFrac = Math.min(1, Math.max(0,
            (ball.speed - BALL_SPEED_BASE) / (BALL_SPEED_MAX - BALL_SPEED_BASE)))
          const halfLife = TRAIL_HALFLIFE_SLOW +
            (TRAIL_HALFLIFE_FAST - TRAIL_HALFLIFE_SLOW) * speedFrac
          // Frame-rate independent: after halfLife seconds of wall clock the
          // trail is at half brightness, whatever the refresh rate.
          const keep = Math.pow(2, -Math.max(raw, 1e-4) / halfLife)

          for (let i = 0; i < MAX_SPARKS; i++) {
            sparkData[i * 3] = sparks[i].x
            sparkData[i * 3 + 1] = sparks[i].y
            sparkData[i * 3 + 2] = sparks[i].life
          }
          const scoreTens = [Math.floor(score[0] / 10), score[0] % 10,
            Math.floor(score[1] / 10), score[1] % 10]

          gl.disable(gl.BLEND)

          // --- pass 1: court into the phosphor buffer ---
          if (read && write) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo)
            gl.viewport(0, 0, COURT_W, COURT_H)
            courtPass.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, read.tex)
              g.uniform1i(uc('uPrev'), 0)
              g.uniform1f(uc('uKeep'), keep)
              g.uniform2f(uc('uBall'), ball.x, ball.y)
              g.uniform2f(uc('uBallPrev'), ballPrevX, ballPrevY)
              g.uniform1f(uc('uPaddleL'), padL)
              g.uniform1f(uc('uPaddleR'), padR)
              g.uniform2f(uc('uSquash'), squashL, squashR)
              g.uniform4f(uc('uScore'), scoreTens[0], scoreTens[1], scoreTens[2], scoreTens[3])
              g.uniform1f(uc('uFlash'), flash)
              g.uniform1f(uc('uFlashSide'), flashSide)
              g.uniform3fv(uc('uSparks'), sparkData)
              g.uniform1f(uc('uSpeed'), speedFrac)
              g.uniform3f(uc('uTint'), tint[0], tint[1], tint[2])
            })
            const t = read; read = write; write = t
          }

          // --- pass 2: the cabinet ---
          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          }
          gl.viewport(0, 0, canvas.width, canvas.height)
          tubePass.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, read ? read.tex : null)
            g.uniform1i(ut('uAccum'), 0)
            g.uniform2f(ut('uResolution'), canvas.width, canvas.height)
            g.uniform3f(ut('uTint'), tint[0], tint[1], tint[2])
            g.uniform1f(ut('uLumaScale'), luminanceScale(canvas))
            g.uniform1f(ut('uTime'), time)
            g.uniform4f(ut('uScore'), scoreTens[0], scoreTens[1], scoreTens[2], scoreTens[3])
            g.uniform2f(ut('uPanelFlash'), panelFlash[0], panelFlash[1])
            g.uniform2f(ut('uMatchPoint'),
              score[0] >= SCORE_LIMIT - 1 ? 1 : 0,
              score[1] >= SCORE_LIMIT - 1 ? 1 : 0)
            g.uniform1f(ut('uSpill'), spill)
            g.uniform1f(ut('uBallLean'), ball.x * 2 - 1)
            g.uniform1f(ut('uHeat'), heat)
            g.uniform2f(ut('uShake'), shakeAmp, shakeT)
            g.uniform4f(ut('uSeed'), grainSeed[0], grainSeed[1], grainSeed[2], grainSeed[3])
          })

          if (post) post.present()
          gl.activeTexture(gl.TEXTURE0)
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (accumA) { accumA.destroy(); accumA = null }
        if (accumB) { accumB.destroy(); accumB = null }
        if (courtPass) { courtPass.destroy(); courtPass = null }
        if (tubePass) { tubePass.destroy(); tubePass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
