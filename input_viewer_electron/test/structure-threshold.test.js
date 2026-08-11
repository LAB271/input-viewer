// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The structure-collapse rule from shadercheck (issues #156, #192).
 *
 * shadercheck.js cannot be imported here -- it reaches for document at module
 * scope and there is no WebGL2 in the node environment -- so the rule is
 * transcribed, the same approach screensaver-aspect.test.js takes for GLSL. The
 * transcription is checked against the real constants parsed out of the source,
 * so the two cannot drift apart silently.
 *
 * What is being pinned is the shape of the rule, because that is what #192 got
 * wrong. A purely relative test cannot work across a set whose healthy densities
 * span 0.0011 to 0.87: at the bottom of that range the 35% band is narrower than
 * the measurement's own frame-to-frame noise, so it fails at random. Requiring
 * the drop to be absolutely meaningful as well as relatively large is what makes
 * the check mean something at both ends.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { STRUCTURE_BASELINES } from '../src/renderer/screensavers/structure-baselines.js'

const SRC = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'screensavers', 'shadercheck.js'),
  'utf8'
)

/** Pull a numeric constant out of shadercheck.js so the test cannot drift. */
function constant(name) {
  const m = new RegExp(`const ${name} = ([0-9.]+)`).exec(SRC)
  if (!m) throw new Error(`${name} not found in shadercheck.js`)
  return Number(m[1])
}

const TOLERANCE = constant('STRUCTURE_DROP_TOLERANCE')
const MIN_ABS_DROP = constant('STRUCTURE_MIN_ABS_DROP')

/** Transcription of the rule in pixelProblem(). True means "report a failure". */
function collapsed(baseline, density) {
  if (!(baseline > 0)) return false
  const floor = baseline * (1 - TOLERANCE)
  const drop = baseline - density
  return density < floor && drop > MIN_ABS_DROP
}

describe('structure-collapse rule constants', () => {
  it('matches the values the harness actually uses', () => {
    expect(TOLERANCE).toBe(0.35)
    expect(MIN_ABS_DROP).toBe(0.0015)
  })

  it('samples a window rather than a single frame', () => {
    // The other half of the #192 fix. If this list shrinks to one entry the
    // measurement is back to being a single arbitrary instant.
    const m = /const STRUCTURE_SAMPLE_FRAMES = \[([^\]]+)\]/.exec(SRC)
    expect(m, 'STRUCTURE_SAMPLE_FRAMES not found').toBeTruthy()
    const frames = m[1].split(',').map((n) => Number(n.trim()))
    expect(frames.length).toBeGreaterThan(1)
    expect(frames[0]).toBe(5) // the other pixel checks still read frame 5
    expect([...frames]).toEqual([...frames].sort((a, b) => a - b))
  })
})

describe('what the rule must catch', () => {
  it('catches the physarum failure: renders, but flat', () => {
    // The bug this check exists for. Simulation correct, display pass emitting a
    // gradient: lit, in range, and structurally empty.
    expect(collapsed(0.0286, 0)).toBe(true)
  })

  it('catches a total collapse for every saver with a real baseline', () => {
    // "Real" meaning a baseline above the absolute margin. Below it the check
    // cannot say anything and does not pretend to -- asserted separately below.
    const protectable = Object.entries(STRUCTURE_BASELINES)
      .filter(([, b]) => b > MIN_ABS_DROP)
    expect(protectable.length).toBeGreaterThan(20)
    for (const [name, baseline] of protectable) {
      expect(collapsed(baseline, 0), `${name} (baseline ${baseline}) going to zero`).toBe(true)
    }
  })

  it('catches a partial but genuine loss of detail', () => {
    // Boids losing three quarters of its structure is a real regression.
    expect(collapsed(0.8723, 0.2)).toBe(true)
  })
})

describe('what the rule must NOT catch', () => {
  it('does not flag the DVD Logo wobble that made #192 flaky', () => {
    // Two consecutive runs on an unchanged tree measured 0.002765 and 0.001695
    // against a 0.0028 baseline. The lower one failed the old relative-only
    // test; neither is a defect.
    expect(collapsed(0.0028, 0.001695)).toBe(false)
    expect(collapsed(0.0028, 0.002765)).toBe(false)
  })

  it('does not flag Mandelbrot swinging 26% between runs', () => {
    expect(collapsed(0.0019, 0.001560)).toBe(false)
    expect(collapsed(0.0019, 0.002140)).toBe(false)
  })

  it('does not flag a saver sitting exactly on its baseline', () => {
    for (const [name, baseline] of Object.entries(STRUCTURE_BASELINES)) {
      expect(collapsed(baseline, baseline), name).toBe(false)
    }
  })

  it('does not flag the wide savers drifting within tolerance', () => {
    // A different seed genuinely moves these; 10% is normal.
    expect(collapsed(0.8723, 0.8)).toBe(false)
    expect(collapsed(0.1735, 0.16)).toBe(false)
  })

  it('skips a zero baseline, which carries no information', () => {
    expect(collapsed(0, 0)).toBe(false)
  })
})

describe('the honest limit of the check', () => {
  it('cannot protect a saver whose baseline is below the absolute margin', () => {
    // Starfield Warp at 0.0011 collapsing to zero is a drop of 0.0011, under the
    // 0.0015 margin, so it is NOT reported. Stated as a test rather than left
    // implicit, because a reader is entitled to know where the check stops
    // working -- the alternative is the false precision that caused #192.
    const unprotected = Object.entries(STRUCTURE_BASELINES)
      .filter(([, b]) => b > 0 && b <= MIN_ABS_DROP)
    for (const [name, baseline] of unprotected) {
      expect(collapsed(baseline, 0), `${name} is knowingly unprotected`).toBe(false)
    }
    // Keep the blind spot small: it should be one or two of the dimmest savers,
    // not a third of the set.
    expect(unprotected.length).toBeLessThanOrEqual(3)
  })
})
