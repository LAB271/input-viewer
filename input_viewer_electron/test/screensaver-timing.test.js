// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tests for frame-rate-independent trail fading (issue #113).
 *
 * The bug being fixed: trails were a fullscreen black quad at a *constant*
 * per-frame alpha, so their length depended on refresh rate. The same 0.08 is
 * twice as aggressive at 120Hz as at 60Hz, which for a videowall app means the
 * screensaver looks different depending on what it happens to be plugged into.
 *
 * These pin the property that matters -- equal wall-clock decay at any frame
 * rate -- rather than the specific alpha, which is an implementation detail.
 */
import { describe, it, expect } from 'vitest'
import { fadeAlphaForHalfLife } from '../src/renderer/screensavers/gl-base.js'

/** Brightness remaining after `seconds` of fading at `fps`. */
function simulate(fps, halfLife, seconds) {
  const dt = 1 / fps
  let brightness = 1
  for (let i = 0; i < Math.round(fps * seconds); i++) {
    brightness *= 1 - fadeAlphaForHalfLife(dt, halfLife)
  }
  return brightness
}

describe('fadeAlphaForHalfLife', () => {
  it('decays to half brightness after exactly one half-life', () => {
    expect(simulate(60, 1.0, 1.0)).toBeCloseTo(0.5, 4)
  })

  it('gives the same decay at 30, 60, 120 and 144 fps', () => {
    // The whole point: identical wall-clock behaviour regardless of frame rate.
    const at = fps => simulate(fps, 0.5, 1.0)
    const reference = at(60)
    for (const fps of [30, 120, 144, 240]) {
      expect(at(fps)).toBeCloseTo(reference, 4)
    }
  })

  it('is markedly better than a constant per-frame alpha', () => {
    // Documents the old behaviour so the regression is visible if anyone
    // reverts to a fixed alpha: 0.08/frame leaves 8.2% at 30fps but 0.67% at
    // 60fps -- a >12x difference for the same second of wall clock.
    const constantAlpha = fps => {
      let b = 1
      for (let i = 0; i < fps; i++) b *= 0.92
      return b
    }
    const spread = constantAlpha(30) / constantAlpha(60)
    expect(spread).toBeGreaterThan(10)

    // The half-life version has essentially no spread.
    const hlSpread = simulate(30, 0.139, 1) / simulate(60, 0.139, 1)
    expect(hlSpread).toBeCloseTo(1, 3)
  })

  it('returns an alpha in [0,1] across plausible and extreme dt', () => {
    for (const dt of [0, 0.001, 1 / 144, 1 / 60, 1 / 30, 0.05, 1, 10]) {
      const a = fadeAlphaForHalfLife(dt, 0.2)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(1)
    }
  })

  it('does not fade at all when no time has passed', () => {
    // A duplicated frame must not darken the trail.
    expect(fadeAlphaForHalfLife(0, 0.5)).toBe(0)
  })

  it('fades harder for a shorter half-life', () => {
    const dt = 1 / 60
    expect(fadeAlphaForHalfLife(dt, 0.1)).toBeGreaterThan(fadeAlphaForHalfLife(dt, 1.0))
  })

  it('clears immediately for a non-positive half-life instead of dividing by zero', () => {
    for (const bad of [0, -1, NaN, undefined]) {
      expect(fadeAlphaForHalfLife(1 / 60, bad)).toBe(1)
    }
  })

  it('treats a negative dt as no elapsed time', () => {
    // Guards against a clock going backwards producing a negative alpha, which
    // would *brighten* the buffer.
    expect(fadeAlphaForHalfLife(-0.5, 0.2)).toBe(0)
  })

  it('preserves the previous 60Hz look for each saver half-life', () => {
    // The three constants were chosen to match the old fixed alphas at 60Hz.
    // If someone retunes them, this flags that the look changed.
    const cases = [
      { name: 'white-particles', halfLife: 0.090, oldAlpha: 0.12 },
      { name: 'boids', halfLife: 0.139, oldAlpha: 0.08 },
      { name: 'strange-attractor', halfLife: 0.283, oldAlpha: 0.04 },
    ]
    for (const { name, halfLife, oldAlpha } of cases) {
      const wasAfter1s = Math.pow(1 - oldAlpha, 60)
      const nowAfter1s = simulate(60, halfLife, 1)
      // Within 10% of the original brightness after a second of decay.
      expect(Math.abs(nowAfter1s - wasAfter1s), name).toBeLessThan(wasAfter1s * 0.1 + 0.002)
    }
  })
})
