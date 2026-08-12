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
const UNIFORM_SPREAD_MIN = constant('UNIFORM_SPREAD_MIN')

/**
 * Transcription of the uniformity rule (#227). True means "report a failure".
 *
 * Deliberately independent of the baseline value, only of whether there is one:
 * the whole point is to protect savers the edge-density rule cannot reach because
 * their baseline sits below MIN_ABS_DROP.
 */
function uniform (baseline, spread) {
  if (!(baseline > 0)) return false
  return spread < UNIFORM_SPREAD_MIN
}

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

describe('the baselines file stays maintainable by hand', () => {
  // scripts/update-structure-baselines.mjs emits entries in descending density
  // order. Hand-editing a single line is the correct move when one saver is
  // deliberately redesigned -- regenerating rewrites all 30 entries from one fresh
  // measurement, burying the intended change in run-to-run noise and conflicting
  // with every other PR touching the file.
  //
  // The cost is that hand-edits can leave the file unsorted, and that is exactly
  // what happened across #210 and #214..#220: six baselines moved, and afterwards
  // the file read 0.19, 0.0081, 0.0001, 0.1624, 0.1029, 0.39. Nothing failed,
  // because nothing checked -- so the next `npm run baselines` would have produced
  // a large reordering diff tangled up with somebody's real change. This is that
  // check.
  it('is sorted by descending density, as the generator emits it', () => {
    const values = Object.values(STRUCTURE_BASELINES)
    for (let i = 1; i < values.length; i++) {
      const names = Object.keys(STRUCTURE_BASELINES)
      expect(
        values[i] <= values[i - 1],
        `"${names[i]}" (${values[i]}) sits after "${names[i - 1]}" (${values[i - 1]}). `
        + 'Hand-edited baselines must keep descending order -- see the file header.'
      ).toBe(true)
    }
  })

  it('rounds to the four decimals the generator writes', () => {
    // A hand-edit of 0.00485 would be silently rounded to 0.0049 by the next
    // regeneration, so the file and the generator would disagree about the value
    // without anyone changing it.
    for (const [name, b] of Object.entries(STRUCTURE_BASELINES)) {
      expect(Number(b.toFixed(4)), `${name} carries more than 4 decimals`).toBe(b)
    }
  })
})

describe('the uniformity rule (#227)', () => {
  it('pins the threshold', () => {
    // Measured across all 30 savers: the lowest p99.9-p05 belonging to a saver
    // with a non-zero baseline is Julia Set at 0.1004, so this leaves a 5x
    // margin. Raising it past ~0.10 would start failing healthy savers.
    expect(UNIFORM_SPREAD_MIN).toBe(0.02)
    expect(UNIFORM_SPREAD_MIN).toBeLessThan(0.1004 / 2)
  })

  it('catches a uniform frame for every saver the edge-density rule cannot', () => {
    // These are the savers whose baseline is under the absolute margin, so a drop
    // to zero edge density is smaller than MIN_ABS_DROP and the rule above stays
    // silent. Before #227 they had no protection at all.
    const subMargin = Object.entries(STRUCTURE_BASELINES)
      .filter(([, b]) => b > 0 && b <= MIN_ABS_DROP)
    expect(subMargin.length).toBeGreaterThan(0)
    for (const [name, baseline] of subMargin) {
      expect(collapsed(baseline, 0), `${name}: edge density rule is blind here`).toBe(false)
      expect(uniform(baseline, 0), `${name}: uniformity rule must catch it`).toBe(true)
    }
  })

  it('catches a flat frame for every saver with a real baseline', () => {
    for (const [name, baseline] of Object.entries(STRUCTURE_BASELINES)) {
      if (!(baseline > 0)) continue
      expect(uniform(baseline, 0), `${name} going flat`).toBe(true)
    }
  })

  it('exempts the savers that legitimately start blank', () => {
    // Wave Tank and Tree Growth carry a zero baseline because they need seconds
    // to develop, and they are the only two whose measured spread is also zero.
    // Gating on baseline > 0 is what keeps them from failing every run.
    const zeroBaseline = Object.entries(STRUCTURE_BASELINES).filter(([, b]) => b === 0)
    expect(zeroBaseline.length).toBeGreaterThan(0)
    for (const [name, baseline] of zeroBaseline) {
      expect(uniform(baseline, 0), `${name} is exempt by design`).toBe(false)
    }
  })

  it('does not fire on the smallest healthy spread measured', () => {
    // Julia Set, the minimum across the set. If this ever fails, the threshold has
    // been raised past what real savers produce.
    expect(uniform(0.0994, 0.1004)).toBe(false)
  })

  it('is silent on a smooth but varied frame, which is a valid picture', () => {
    // Plasma is the case in point: almost no edges (baseline 0.0001) and a
    // perfectly good image. Low edge density must not imply uniform.
    expect(uniform(0.0001, 0.1259)).toBe(false)
  })
})
