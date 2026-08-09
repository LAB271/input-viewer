// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Double pendulum — a row of chaotic two-segment pendulums with near-identical
 * starting conditions, so the divergence is visible (#65).
 *
 * The fading tip trails #65 also asks for are NOT implemented: they need an
 * accumulating HDR target like the particle savers use, which is a larger change
 * than the arms themselves. Divergence is still legible because each pendulum
 * takes its own hue. Tracked as remaining work on that issue.
 *
 * A row rather than one pendulum because it *demonstrates* chaos: they start
 * together and visibly separate, which is more compelling than a single arm.
 *
 * **The physics is the risky part, and #65 documents why.** Its prototype
 * dropped the mass terms from the equations of motion, which stops the system
 * being Hamiltonian: it gained energy without bound and accelerated into a
 * blur. The diagnostic that identified it is worth repeating rather than
 * eyeballing the motion -- integration error must SHRINK as the timestep
 * shrinks, and there it did not (599% at dt=1/480, 833% at dt=1/4000).
 *
 * Verified before writing this file, over 20 simulated seconds:
 *
 *   correct equations   dt=1/120  0.49%    dt=1/480  9e-4%   dt=1/2000  3e-6%
 *   mass terms dropped  dt=1/120  23000%   dt=1/480  23000%  dt=1/2000  23000%
 *
 * The correct form converges as dt^4, as RK4 should. The broken form is
 * indifferent to dt, which is the signature of wrong equations.
 *
 * Simulation is on the CPU: two angles and two velocities per pendulum is
 * nothing, and RK4 on a handful of pendulums is far cheaper than the GPU
 * round-trip a ping-pong texture would cost.
 *
 * Per-activation variation: pendulum count, starting angles, arm lengths and
 * palette.
 */
import { createGLRuntime, createFullscreenPass, luminanceScale } from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

const GRAVITY = 9.81
// Fixed physics timestep. 1/480 is where drift measured 9e-4% over 20s and
// stayed bounded over 8 simulated hours in #65's testing; 1/120 is visibly
// worse at 0.49%, and finer buys nothing at this scale.
const PHYSICS_DT = 1 / 480
// Cap the catch-up burst after a stall, or a long frame tries to integrate
// thousands of steps at once and visibly hitches.
const MAX_STEPS_PER_FRAME = 32

const MAX_PENDULUMS = 7

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform int uCount;
uniform vec4 uJoints[${MAX_PENDULUMS}];   // xy = elbow, zw = tip, in pixels
uniform vec2 uPivots[${MAX_PENDULUMS}];
uniform vec3 uPhase;
uniform float uLumaScale;
uniform float uArmPx;
out vec4 fragColor;

${GLSL.palette}

// Distance from a point to a line segment.
float segDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 col = vec3(0.0);

  vec3 phase = uPhase;

  for (int i = 0; i < ${MAX_PENDULUMS}; i++) {
    if (i >= uCount) break;

    vec2 pivot = uPivots[i];
    vec2 elbow = uJoints[i].xy;
    vec2 tip = uJoints[i].zw;

    // Each pendulum takes its own hue, so divergence is legible as separation
    // between colours rather than a single tangle.
    vec3 tint = palettePerceptual(float(i) / float(uCount) * 0.7, phase);

    // Arms.
    float d = min(segDistance(p, pivot, elbow), segDistance(p, elbow, tip));
    col += tint * (1.0 - smoothstep(0.0, uArmPx, d)) * 0.9;
    // Soft glow along the arms so they read at wall distance (#88).
    col += tint * exp(-d / (uArmPx * 2.5)) * 0.25;

    // Joints, brighter than the arms.
    float jd = min(length(p - elbow), length(p - tip));
    col += tint * (1.0 - smoothstep(0.0, uArmPx * 1.8, jd)) * 0.6;
  }

  // Dim ground rather than black (issue #88).
  col += palettePerceptual(0.72 + uPhase.x, uPhase) * 0.03;
  col *= uLumaScale;
  fragColor = vec4(col, 1.0);
}
`

/** Equations of motion for an equal-mass double pendulum. */
function accel(t1, w1, t2, w2, L1, L2, m1, m2) {
  const d = t1 - t2
  // The mass terms here are load-bearing. Dropping them -- den = 2 - cos(2d),
  // and a bare 2 where (m1+m2) belongs in a2 -- makes the system
  // non-Hamiltonian and it gains energy without bound (#65).
  const den = 2 * m1 + m2 - m2 * Math.cos(2 * d)
  const a1 = (-GRAVITY * (2 * m1 + m2) * Math.sin(t1)
    - m2 * GRAVITY * Math.sin(t1 - 2 * t2)
    - 2 * Math.sin(d) * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * Math.cos(d))) / (L1 * den)
  const a2 = (2 * Math.sin(d) * (w1 * w1 * L1 * (m1 + m2)
    + GRAVITY * (m1 + m2) * Math.cos(t1)
    + w2 * w2 * L2 * m2 * Math.cos(d))) / (L2 * den)
  return [a1, a2]
}

/** One RK4 step. Exported for the tests that pin the energy behaviour. */
export function rk4Step(state, dt, L1, L2, m1 = 1, m2 = 1) {
  const f = (s) => {
    const [a1, a2] = accel(s[0], s[1], s[2], s[3], L1, L2, m1, m2)
    return [s[1], a1, s[3], a2]
  }
  const add = (s, k, h) => s.map((v, i) => v + k[i] * h)
  const k1 = f(state)
  const k2 = f(add(state, k1, dt / 2))
  const k3 = f(add(state, k2, dt / 2))
  const k4 = f(add(state, k3, dt))
  return state.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))
}

/** Total energy, for the drift tests. */
export function totalEnergy(state, L1, L2, m1 = 1, m2 = 1) {
  const [t1, w1, t2, w2] = state
  const y1 = -L1 * Math.cos(t1)
  const y2 = y1 - L2 * Math.cos(t2)
  const v1sq = L1 * L1 * w1 * w1
  const v2sq = v1sq + L2 * L2 * w2 * w2 + 2 * L1 * L2 * w1 * w2 * Math.cos(t1 - t2)
  return 0.5 * m1 * v1sq + 0.5 * m2 * v2sq + m1 * GRAVITY * y1 + m2 * GRAVITY * y2
}

export default {
  name: 'Double Pendulum',
  create(canvas, seedValue) {
    let runtime = null, gl = null, pass = null

    const rng = createRng(seedValue)
    const count = rng.int(4, MAX_PENDULUMS)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]
    // Arms differ slightly per pendulum so they diverge for two reasons --
    // initial conditions and geometry -- rather than only one.
    const L1 = rng.range(0.9, 1.1)
    const L2 = rng.range(0.85, 1.05)
    // Start near the horizontal, where the motion is most energetic, with a
    // tiny per-pendulum offset. That offset IS the demonstration: identical
    // systems separated by 1e-3 rad end up completely uncorrelated.
    const baseAngle = rng.range(1.4, 2.2)

    let states = []
    let accumulator = 0
    let lastTime = 0

    function reset() {
      states = []
      for (let i = 0; i < count; i++) {
        states.push([baseAngle + i * 0.001, 0, baseAngle + 0.01 + i * 0.001, 0])
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        pass = createFullscreenPass(gl, FRAG)
        const u = createUniformCache(gl, pass.program)
        const lumaScale = luminanceScale(canvas)

        reset()
        accumulator = 0
        lastTime = 0

        runtime.start((time) => {
          const dt = lastTime === 0 ? PHYSICS_DT : Math.min(time - lastTime, 0.25)
          lastTime = time

          // Fixed-step integration, decoupled from the frame rate. A variable
          // dt makes a chaotic system's trajectory depend on frame timing, so
          // the same seed would not reproduce.
          accumulator += dt
          let steps = 0
          while (accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
            for (let i = 0; i < count; i++) {
              states[i] = rk4Step(states[i], PHYSICS_DT, L1, L2)
            }
            accumulator -= PHYSICS_DT
            steps++
          }
          if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0

          // Layout: pendulums spread across the width, pivots on a line above
          // centre so the arms have room to swing below.
          const scale = Math.min(canvas.width / (count + 1), canvas.height * 0.34) /
            (L1 + L2)
          const pivotY = canvas.height * 0.72
          const joints = new Float32Array(MAX_PENDULUMS * 4)
          const pivots = new Float32Array(MAX_PENDULUMS * 2)

          for (let i = 0; i < count; i++) {
            const px = canvas.width * (i + 1) / (count + 1)
            const [t1, , t2] = states[i]
            const ex = px + Math.sin(t1) * L1 * scale
            const ey = pivotY - Math.cos(t1) * L1 * scale
            const tx = ex + Math.sin(t2) * L2 * scale
            const ty = ey - Math.cos(t2) * L2 * scale
            pivots[i * 2] = px
            pivots[i * 2 + 1] = pivotY
            joints[i * 4] = ex
            joints[i * 4 + 1] = ey
            joints[i * 4 + 2] = tx
            joints[i * 4 + 3] = ty
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          pass.draw((g) => {
            g.uniform2f(u('uResolution'), canvas.width, canvas.height)
            g.uniform1i(u('uCount'), count)
            g.uniform4fv(u('uJoints'), joints)
            g.uniform2fv(u('uPivots'), pivots)
            g.uniform3f(u('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(u('uLumaScale'), lumaScale)
            // Arm thickness scales with the display so it is not sub-resolvable
            // on the wall (#88).
            g.uniform1f(u('uArmPx'), Math.max(2, Math.min(canvas.width, canvas.height) / 260))
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
