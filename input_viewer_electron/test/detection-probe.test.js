// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The cheap probe in front of the full frame comparison (issue #161).
 *
 * The probe exists to make detection affordable: a full scan is 32,400 sample
 * comparisons on the main thread, per device per cycle, multiplied by the
 * number of stored references. The probe rejects a live feed in 32.
 *
 * Its one safety-critical property is asymmetric, and every test here is about
 * that asymmetry:
 *
 *   a false PASS is harmless  -- it costs a scan that would have run anyway
 *   a false REJECT is a bug   -- detection silently stops working
 *
 * So the probe is allowed to be sloppy in one direction only. The property
 * test below is the one that matters; the rest are illustrative cases.
 */
import { describe, it, expect } from 'vitest'
import { probeFrames, compareFrames, CONFIG } from '../src/renderer/detection-simple.js'

const W = 480, H = 270

/** A uniform frame. */
function solid(r, g, b) {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
  }
  return { width: W, height: H, data }
}

/** A frame where `frac` of pixels are replaced with a clearly different colour. */
function withNoise(base, frac, seed = 1) {
  const out = {
    width: base.width,
    height: base.height,
    data: new Uint8ClampedArray(base.data)
  }
  // Deterministic LCG so a failure is reproducible.
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const pixels = W * H
  for (let p = 0; p < pixels; p++) {
    if (rand() < frac) {
      const o = p * 4
      out.data[o] = 255 - base.data[o]
      out.data[o + 1] = 255 - base.data[o + 1]
      out.data[o + 2] = 255 - base.data[o + 2]
    }
  }
  return out
}

describe('probeFrames', () => {
  it('passes an identical frame', () => {
    const ref = solid(12, 12, 12)
    expect(probeFrames(solid(12, 12, 12), ref)).toBe(true)
  })

  it('passes a frame differing by less than the pixel threshold', () => {
    // Within CONFIG.pixelDifferenceThreshold, so the full scan would match --
    // the probe must not pre-empt that.
    const delta = CONFIG.pixelDifferenceThreshold - 1
    const ref = solid(100, 100, 100)
    expect(probeFrames(solid(100 + delta, 100, 100), ref)).toBe(true)
  })

  it('rejects a completely different frame', () => {
    expect(probeFrames(solid(240, 240, 240), solid(12, 12, 12))).toBe(false)
  })

  it('returns false for an empty frame rather than dividing by zero', () => {
    const empty = { width: 0, height: 0, data: new Uint8ClampedArray(0) }
    expect(probeFrames(empty, empty)).toBe(false)
  })
})

describe('probe never rejects what the full scan would match', () => {
  // The safety property, stated directly: for a range of noise levels, if
  // compareFrames says "match" then probeFrames must not have rejected it.
  // A violation here means detection can silently stop working.
  it('holds across noise levels and seeds', () => {
    const ref = solid(12, 12, 12)
    let checked = 0
    for (const frac of [0, 0.001, 0.005, 0.01, 0.02, 0.03, 0.05]) {
      for (let seed = 1; seed <= 12; seed++) {
        const frame = withNoise(ref, frac, seed)
        const fullMatch = compareFrames(frame, ref)
        if (fullMatch) {
          expect(
            probeFrames(frame, ref),
            `probe rejected a frame the full scan matched (frac=${frac}, seed=${seed})`
          ).toBe(true)
          checked++
        }
      }
    }
    // Guard against the assertion never running: if the noise levels drifted so
    // that nothing matches, the property above would pass vacuously.
    expect(checked).toBeGreaterThan(10)
  })
})

describe('probe rejects live feeds cheaply', () => {
  it('rejects heavily differing frames nearly always', () => {
    // The performance claim: a live feed should almost never reach the scan.
    const ref = solid(12, 12, 12)
    let passed = 0
    const trials = 60
    for (let seed = 1; seed <= trials; seed++) {
      if (probeFrames(withNoise(ref, 0.8, seed), ref)) passed++
    }
    // Statistically ~0 at 80% differing; allow a small margin.
    expect(passed / trials).toBeLessThan(0.05)
  })

  it('mostly rejects even a subtly different feed', () => {
    // The hard case that sized the probe at 32 points rather than 5.
    const ref = solid(12, 12, 12)
    let passed = 0
    const trials = 60
    for (let seed = 1; seed <= trials; seed++) {
      if (probeFrames(withNoise(ref, 0.3, seed), ref)) passed++
    }
    expect(passed / trials).toBeLessThan(0.25)
  })
})
