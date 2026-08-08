// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Pong AI must be imperfect (issue #58).
 *
 * The failure this guards against is subtle and silent: paddles that never
 * miss produce an endless rally, the score never moves, and a no-signal wall
 * showing a frozen scoreboard reads as a crashed app. Nothing throws, nothing
 * fails to compile, and shadercheck is perfectly happy.
 *
 * It is not hypothetical -- the first set of profiles did exactly this. A
 * paddle saves when it is within PADDLE_H/2 + BALL_R = 0.096 of the ball, and
 * the original aim error topped out at 0.055 while maxSpeed was high enough to
 * cross the whole court inside the ball's flight time. Simulating five minutes
 * of every matchup scored zero points in two of the six pairings.
 *
 * The game loop is transcribed here rather than imported because it lives
 * inside create() and drives GL. The constants are duplicated deliberately: if
 * someone retunes pong.js without updating these, the test fails, which is the
 * point.
 */
import { describe, it, expect } from 'vitest'

const PADDLE_X = 0.045
const PADDLE_H = 0.17
const PADDLE_W = 0.011
const BALL_R = 0.011
const BALL_SPEED_BASE = 0.42
const BALL_SPEED_MAX = 0.85
const RALLY_SPEEDUP = 1.035
const SERVE_DELAY = 1.1
const SCORE_LIMIT = 11

// Must mirror AI_PROFILES in pong.js.
const AI_PROFILES = [
  { error: 0.12, reaction: 0.20, maxSpeed: 0.38 },
  { error: 0.17, reaction: 0.28, maxSpeed: 0.32 },
  { error: 0.23, reaction: 0.36, maxSpeed: 0.27 }
]

// The distance within which a paddle saves the ball. Any aim error smaller
// than this cannot, on its own, ever cause a miss.
const SAVE_TOLERANCE = PADDLE_H * 0.5 + BALL_R

function simulate(L, R, seed, seconds) {
  let rs = seed >>> 0 || 1
  const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296)
  const range = (a, b) => a + rnd() * (b - a)

  const ball = { x: 0.5, y: 0.5, vx: 0, vy: 0, speed: BALL_SPEED_BASE }
  let padL = 0.5, padR = 0.5, errL = 0, errR = 0, reactL = 0, reactR = 0
  let score = [0, 0], serveTimer, rallies = 0

  const serve = (towards) => {
    ball.x = 0.5
    ball.y = range(0.35, 0.65)
    ball.speed = BALL_SPEED_BASE
    const a = range(0.28, 0.72) * (rnd() < 0.5 ? 1 : -1)
    ball.vx = towards * Math.cos(a * 0.9)
    ball.vy = Math.sin(a * 0.9)
    const l = Math.hypot(ball.vx, ball.vy)
    ball.vx /= l; ball.vy /= l
    errL = range(-L.error, L.error); errR = range(-R.error, R.error)
    reactL = L.reaction; reactR = R.reaction
  }

  serve(rnd() < 0.5 ? 1 : -1)
  serveTimer = SERVE_DELAY
  const dt = 1 / 120

  for (let s = 0; s < seconds / dt; s++) {
    if (serveTimer > 0) {
      serveTimer -= dt
      padL += (0.5 - padL) * Math.min(1, dt * 2.2)
      padR += (0.5 - padR) * Math.min(1, dt * 2.2)
      continue
    }
    ball.x += ball.vx * ball.speed * dt
    ball.y += ball.vy * ball.speed * dt
    if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy) }
    if (ball.y > 1 - BALL_R) { ball.y = 1 - BALL_R; ball.vy = -Math.abs(ball.vy) }

    const lx = PADDLE_X, rx = 1 - PADDLE_X
    if (ball.vx < 0 && ball.x - BALL_R <= lx + PADDLE_W && ball.x > lx - 0.05) {
      if (Math.abs(ball.y - padL) < SAVE_TOLERANCE) {
        ball.x = lx + PADDLE_W + BALL_R; ball.vx = Math.abs(ball.vx)
        ball.vy += (ball.y - padL) * 1.9
        ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
        reactR = R.reaction; rallies++
      }
    }
    if (ball.vx > 0 && ball.x + BALL_R >= rx - PADDLE_W && ball.x < rx + 0.05) {
      if (Math.abs(ball.y - padR) < SAVE_TOLERANCE) {
        ball.x = rx - PADDLE_W - BALL_R; ball.vx = -Math.abs(ball.vx)
        ball.vy += (ball.y - padR) * 1.9
        ball.speed = Math.min(ball.speed * RALLY_SPEEDUP, BALL_SPEED_MAX)
        reactL = L.reaction; rallies++
      }
    }
    { const l = Math.hypot(ball.vx, ball.vy) || 1; ball.vx /= l; ball.vy /= l }

    if (ball.x < -0.03) { score[1]++; serveTimer = SERVE_DELAY; serve(-1) }
    else if (ball.x > 1.03) { score[0]++; serveTimer = SERVE_DELAY; serve(1) }
    if (score[0] >= SCORE_LIMIT || score[1] >= SCORE_LIMIT) score = [0, 0]

    reactL = Math.max(0, reactL - dt); reactR = Math.max(0, reactR - dt)
    const tL = (ball.vx < 0 && reactL <= 0) ? ball.y + errL : 0.5
    const tR = (ball.vx > 0 && reactR <= 0) ? ball.y + errR : 0.5
    const sL = L.maxSpeed * dt, sR = R.maxSpeed * dt
    padL += Math.max(-sL, Math.min(sL, tL - padL))
    padR += Math.max(-sR, Math.min(sR, tR - padR))
    const h = PADDLE_H * 0.5
    padL = Math.max(h, Math.min(1 - h, padL))
    padR = Math.max(h, Math.min(1 - h, padR))

    if (!Number.isFinite(ball.x) || !Number.isFinite(ball.y)) {
      return { escaped: true, points: score[0] + score[1], rallies }
    }
  }
  return { escaped: false, points: score[0] + score[1], rallies }
}

describe('Pong AI profiles', () => {
  it('has at least one profile whose aim error can exceed the save tolerance', () => {
    // If every error is inside the tolerance, no paddle can ever miss on aim
    // alone and the rally depends entirely on speed limits.
    const maxError = Math.max(...AI_PROFILES.map(p => p.error))
    expect(maxError).toBeGreaterThan(SAVE_TOLERANCE)
  })

  it('cannot let any paddle cross the whole court inside the ball flight time', () => {
    // This is what made the first attempt unbeatable: reaction delay is
    // irrelevant if the paddle out-runs the ball anyway.
    const courtCross = 1 - 2 * PADDLE_X
    const fastestFlight = courtCross / BALL_SPEED_MAX
    for (const p of AI_PROFILES) {
      const reach = Math.max(0, fastestFlight - p.reaction) * p.maxSpeed
      expect(reach).toBeLessThan(1.0)
    }
  })

  it('scores points in every matchup, so the scoreboard never freezes', () => {
    for (let i = 0; i < AI_PROFILES.length; i++) {
      for (let j = i; j < AI_PROFILES.length; j++) {
        // Three seeds so a single lucky rally cannot carry the assertion.
        const total = [11, 29, 53].reduce(
          (sum, seed) => sum + simulate(AI_PROFILES[i], AI_PROFILES[j], seed, 300).points, 0)
        expect(total, `profile ${i} vs ${j} never scored`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps rallies going rather than trading instant points', () => {
    // The opposite failure: paddles so bad the ball just crosses untouched.
    const r = simulate(AI_PROFILES[1], AI_PROFILES[1], 7, 120)
    expect(r.rallies).toBeGreaterThan(20)
  })

  it('never lets the ball escape the court', () => {
    for (let i = 0; i < AI_PROFILES.length; i++) {
      const r = simulate(AI_PROFILES[i], AI_PROFILES[2 - i], 99 + i, 300)
      expect(r.escaped).toBe(false)
    }
  })
})
