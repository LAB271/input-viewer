// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Double pendulum physics (#65).
 *
 * #65's prototype dropped the mass terms from the equations of motion, which
 * stops the system being Hamiltonian: it gained energy without bound and
 * accelerated into a blur. The issue records the diagnostic that found it, and
 * it is the one worth automating:
 *
 *   **Integration error must shrink as the timestep shrinks.**
 *
 * If it does not, the equations are wrong rather than the integrator. Eyeballing
 * the motion cannot distinguish the two -- a chaotic system looks chaotic either
 * way, which is exactly why the bug survived a visual review.
 */
import { describe, it, expect } from 'vitest'
import { rk4Step, totalEnergy } from '../src/renderer/screensavers/double-pendulum.js'

const L1 = 1, L2 = 1

/** Max relative energy drift over `seconds` of simulated time. */
function maxDrift(dt, seconds) {
  let state = [Math.PI / 2, 0, Math.PI / 2 + 0.01, 0]
  const e0 = totalEnergy(state, L1, L2)
  let worst = 0
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    state = rk4Step(state, dt, L1, L2)
    worst = Math.max(worst, Math.abs((totalEnergy(state, L1, L2) - e0) / e0))
  }
  return worst
}

describe('energy conservation', () => {
  it('drift shrinks as the timestep shrinks', () => {
    // The diagnostic. RK4 is fourth-order, so halving dt should cut error
    // sharply; a system whose error is INDIFFERENT to dt has wrong equations.
    // Measured on the broken variant: ~23000% at every timestep.
    const coarse = maxDrift(1 / 120, 20)
    const fine = maxDrift(1 / 480, 20)
    const finer = maxDrift(1 / 2000, 20)

    expect(fine).toBeLessThan(coarse)
    expect(finer).toBeLessThan(fine)
    // Convergence should be steep, not marginal.
    expect(fine).toBeLessThan(coarse / 10)
  })

  it('stays bounded at the timestep the saver uses', () => {
    // PHYSICS_DT is 1/480. The target from #65 is well under 1%.
    expect(maxDrift(1 / 480, 20)).toBeLessThan(0.01)
  })

  it('does not gain energy without bound over a long run', () => {
    // The visible symptom of the original bug: pendulums accelerating into a
    // blur. 120 simulated seconds is enough for unbounded growth to show.
    expect(maxDrift(1 / 480, 120)).toBeLessThan(0.02)
  })
})

describe('chaotic divergence', () => {
  it('separates two nearly identical pendulums', () => {
    // The saver's whole premise: a 1e-3 rad difference must become
    // uncorrelated. If it did not, the row would move in lockstep and there
    // would be nothing to look at.
    let a = [2.0, 0, 2.01, 0]
    let b = [2.001, 0, 2.011, 0]
    for (let i = 0; i < Math.round(30 / (1 / 480)); i++) {
      a = rk4Step(a, 1 / 480, L1, L2)
      b = rk4Step(b, 1 / 480, L1, L2)
    }
    // After 30s the angles should bear no resemblance to each other.
    const gap = Math.abs(a[0] - b[0])
    expect(gap).toBeGreaterThan(0.5)
  })

  it('is deterministic for a given start, so a seed reproduces', () => {
    const run = () => {
      let s = [1.8, 0, 1.81, 0]
      for (let i = 0; i < 5000; i++) s = rk4Step(s, 1 / 480, L1, L2)
      return s
    }
    expect(run()).toEqual(run())
  })
})

describe('numerical safety', () => {
  it('never produces NaN, even from a degenerate start', () => {
    // Both arms exactly vertical makes sin(d) zero throughout; the denominator
    // must not vanish.
    let s = [0, 0, 0, 0]
    for (let i = 0; i < 2000; i++) s = rk4Step(s, 1 / 480, L1, L2)
    for (const v of s) expect(Number.isFinite(v)).toBe(true)
  })

  it('handles unequal arm lengths', () => {
    let s = [1.5, 0, 1.6, 0]
    for (let i = 0; i < 2000; i++) s = rk4Step(s, 1 / 480, 1.2, 0.7)
    for (const v of s) expect(Number.isFinite(v)).toBe(true)
  })
})
