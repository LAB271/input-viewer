// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Pong — two AI paddles playing each other forever, with a running score
 * (issue #58).
 *
 * Unlike every other saver in the set this one has real game state, so the
 * simulation lives in JS and only the drawing is a shader. The state is small
 * (two paddles, a ball, two scores) and is passed as uniforms each frame.
 *
 * **The AI has to be imperfect on purpose.** A paddle that tracks the ball's y
 * exactly never misses, the score never changes, and the rally continues
 * forever -- which reads as a screensaver that has frozen. Each paddle instead
 * gets a reaction delay, a target error that is re-rolled per rally, and a
 * maximum speed that caps how far it can travel, so points are genuinely won
 * and lost. See AI_PROFILES for how those interact.
 *
 * Everything is computed in a normalised play field and mapped to the canvas
 * at draw time, so the game is the same game at 16:10 and at 6000x1200 -- on
 * the wall the court is simply wider, exactly as a real wide Pong table would
 * be (issue #114).
 *
 * Per-activation variation: paddle skill, ball speed, serve direction and
 * palette.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Play field is normalised: x in [0,1], y in [0,1]. The shader maps this to
// whatever the canvas aspect happens to be.
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

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec2 uBall;
uniform float uPaddleL;
uniform float uPaddleR;
uniform vec3 uTint;
uniform float uLumaScale;
uniform float uFlash;       // 0..1, brief flash on the wall that was scored on
uniform float uFlashSide;   // -1 left, +1 right
uniform vec4 uScore;        // xy = left digits, zw = right digits (tens, ones)
out vec4 fragColor;

${GLSL.hash}

// Signed distance to an axis-aligned box.
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// 7-segment digit. Cheaper and crisper at wall scale than a font texture, and
// the score is the only text this saver needs.
// Segment order: top, top-left, top-right, middle, bottom-left, bottom-right, bottom.
float digit(vec2 p, int n) {
  // Segment masks per digit 0-9, packed as 7 bits.
  int masks[10];
  masks[0] = 119; masks[1] = 36;  masks[2] = 93;  masks[3] = 109; masks[4] = 46;
  masks[5] = 107; masks[6] = 123; masks[7] = 37;  masks[8] = 127; masks[9] = 111;
  int m = masks[n];

  float d = 1e9;
  float t = 0.055;   // segment thickness
  // Horizontal segments: top, middle, bottom.
  if ((m & 1) != 0)  d = min(d, sdBox(p - vec2(0.0,  0.34), vec2(0.16, t)));
  if ((m & 8) != 0)  d = min(d, sdBox(p - vec2(0.0,  0.00), vec2(0.16, t)));
  if ((m & 64) != 0) d = min(d, sdBox(p - vec2(0.0, -0.34), vec2(0.16, t)));
  // Vertical segments.
  if ((m & 2) != 0)  d = min(d, sdBox(p - vec2(-0.18,  0.17), vec2(t, 0.17)));
  if ((m & 4) != 0)  d = min(d, sdBox(p - vec2( 0.18,  0.17), vec2(t, 0.17)));
  if ((m & 16) != 0) d = min(d, sdBox(p - vec2(-0.18, -0.17), vec2(t, 0.17)));
  if ((m & 32) != 0) d = min(d, sdBox(p - vec2( 0.18, -0.17), vec2(t, 0.17)));
  return d;
}

void main() {
  // Court space: x,y in [0,1] across the canvas. The court fills the canvas, so
  // a 5:1 wall simply gets a wide table rather than a stretched one -- paddles
  // and ball are sized against the SHORT axis so they stay square.
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;

  // Work in a space where one unit of y equals one unit of x visually.
  vec2 p = vec2(uv.x * aspect, uv.y);
  float ballR = ${BALL_R};
  float padW = ${PADDLE_W};
  float padH = ${PADDLE_H};

  vec3 col = vec3(0.0);

  // Centre net: a dashed vertical line.
  {
    float netX = 0.5 * aspect;
    float dash = step(0.5, fract(uv.y * 26.0));
    float d = abs(p.x - netX);
    col += uTint * 0.22 * dash * smoothstep(0.0035, 0.0, d);
  }

  // Paddles.
  float lx = ${PADDLE_X} * aspect;
  float rx = (1.0 - ${PADDLE_X}) * aspect;
  float dl = sdBox(p - vec2(lx, uPaddleL), vec2(padW, padH * 0.5));
  float dr = sdBox(p - vec2(rx, uPaddleR), vec2(padW, padH * 0.5));
  float paddle = min(dl, dr);
  col += uTint * smoothstep(0.004, 0.0, paddle);
  // Soft halo so the paddles do not read as flat rectangles at distance.
  col += uTint * 0.35 * exp(-paddle * 90.0);

  // Ball, with a soft core.
  vec2 ballP = vec2(uBall.x * aspect, uBall.y);
  float db = length(p - ballP) - ballR;
  col += vec3(1.0) * smoothstep(0.004, 0.0, db);
  col += uTint * 0.6 * exp(-max(db, 0.0) * 55.0);

  // Score, drawn large and faint behind the play, like the original.
  {
    float sy = 0.80;
    float scale = 0.13;
    // Left score to the left of the net, right score to the right.
    vec2 lp = (p - vec2(0.5 * aspect - 0.13, sy)) / scale;
    vec2 rp = (p - vec2(0.5 * aspect + 0.13, sy)) / scale;
    float dsc = 1e9;
    // Tens digit only when non-zero, so single-digit scores are centred.
    if (uScore.x > 0.5) dsc = min(dsc, digit(lp + vec2(0.42, 0.0), int(uScore.x)));
    dsc = min(dsc, digit(lp - vec2(0.42, 0.0) * step(0.5, uScore.x), int(uScore.y)));
    if (uScore.z > 0.5) dsc = min(dsc, digit(rp + vec2(0.42, 0.0), int(uScore.z)));
    dsc = min(dsc, digit(rp - vec2(0.42, 0.0) * step(0.5, uScore.z), int(uScore.w)));
    col += uTint * 0.30 * smoothstep(0.02, 0.0, dsc);
  }

  // Flash on the wall that just conceded, so a point is visible even if you
  // were not watching the ball.
  if (uFlash > 0.001) {
    float wallX = uFlashSide < 0.0 ? 0.0 : aspect;
    float d = abs(p.x - wallX);
    col += uTint * uFlash * 0.9 * exp(-d * 7.0);
  }

  // Dim background rather than pure black (issue #88).
  col += uTint * 0.02;
  col *= uLumaScale;

  fragColor = vec4(col, 1.0);
}
`

export default {
  name: 'Pong',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null

    // RNG in create(), not start(), so the match survives a start/stop cycle.
    const rng = createRng(seedValue)
    const tint = (() => {
      // Classic phosphor white, plus a few CRT-ish alternates.
      const options = [
        [0.88, 1.0, 0.90],   // white-green phosphor
        [0.55, 1.0, 0.62],   // green
        [1.0, 0.80, 0.42],   // amber
        [0.62, 0.85, 1.0]    // cold blue
      ]
      return options[rng.int(0, options.length - 1)]
    })()

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
      if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy) }
      if (ball.y > 1 - BALL_R) { ball.y = 1 - BALL_R; ball.vy = -Math.abs(ball.vy) }

      // --- Paddle collisions ---
      // Checked as a crossing rather than an overlap: at high ball speeds a
      // pure overlap test can miss the paddle entirely between two frames and
      // the ball tunnels straight through, which looks like a bug even though
      // the AI was in position.
      const lx = PADDLE_X, rx = 1 - PADDLE_X
      if (ball.vx < 0 && ball.x - BALL_R <= lx + PADDLE_W && ball.x > lx - 0.05) {
        if (Math.abs(ball.y - padL) < PADDLE_H * 0.5 + BALL_R) {
          ball.x = lx + PADDLE_W + BALL_R
          ball.vx = Math.abs(ball.vx)
          // Deflect by where it struck the paddle, so rallies develop angle.
          ball.vy += (ball.y - padL) * 1.9
          ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
          reactR = profileR.reaction
        }
      }
      if (ball.vx > 0 && ball.x + BALL_R >= rx - PADDLE_W && ball.x < rx + 0.05) {
        if (Math.abs(ball.y - padR) < PADDLE_H * 0.5 + BALL_R) {
          ball.x = rx - PADDLE_W - BALL_R
          ball.vx = -Math.abs(ball.vx)
          ball.vy += (ball.y - padR) * 1.9
          ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
          reactL = profileL.reaction
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
        serveTimer = SERVE_DELAY; serve(-1)
      } else if (ball.x > 1.03) {
        score[0]++; flash = 1; flashSide = 1
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

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        pass = createFullscreenPass(gl, FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        resetMatch()
        lastTime = 0

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
          while (remaining > 0 && guard-- > 0) {
            const dt = Math.min(STEP, remaining)
            update(dt)
            remaining -= dt
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          pass.draw((g) => {
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform2f(u('uBall'), ball.x, ball.y)
            g.uniform1f(u('uPaddleL'), padL)
            g.uniform1f(u('uPaddleR'), padR)
            g.uniform3f(u('uTint'), tint[0], tint[1], tint[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
            g.uniform1f(u('uFlash'), flash)
            g.uniform1f(u('uFlashSide'), flashSide)
            g.uniform4f(u('uScore'),
              Math.floor(score[0] / 10), score[0] % 10,
              Math.floor(score[1] / 10), score[1] % 10)
          })
        })
      },
      stop() {
        if (pass) { pass.destroy(); pass = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
