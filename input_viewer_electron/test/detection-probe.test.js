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
import { probeFrames, compareFrames, matchRatio, CONFIG } from '../src/renderer/detection-simple.js'

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

describe('matchRatio (diagnostics)', () => {
  // compareFrames returns a boolean and bails early, so a failure cannot be
  // told apart from a near-miss. matchRatio always scans fully and returns the
  // number, which is what makes __detectState() able to say "best match 88%,
  // needed 95%" instead of just "no".
  const px = (r, g, b) => {
    const data = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
    }
    return { width: W, height: H, data }
  }

  it('is 1 for identical frames', () => {
    expect(matchRatio(px(20, 40, 160), px(20, 40, 160))).toBe(1)
  })

  it('is 1 within the pixel threshold', () => {
    const d = CONFIG.pixelDifferenceThreshold - 1
    expect(matchRatio(px(20 + d, 40, 160), px(20, 40, 160))).toBe(1)
  })

  it('is 0 for a completely different frame', () => {
    expect(matchRatio(px(240, 240, 240), px(20, 40, 160))).toBe(0)
  })

  it('is 0 when the sizes differ, matching compareFrames', () => {
    // The real-world case: a card that changes mode between capture and
    // comparison. Reported as 0 rather than throwing.
    const small = { width: 320, height: 180, data: new Uint8ClampedArray(320 * 180 * 4) }
    expect(matchRatio(small, px(20, 40, 160))).toBe(0)
  })

  it('reports a partial match as a fraction, not a boolean', () => {
    const ref = px(12, 12, 12)
    const half = withNoise(ref, 0.5, 3)
    const r = matchRatio(half, ref)
    expect(r).toBeGreaterThan(0.2)
    expect(r).toBeLessThan(0.8)
  })
})

describe('frame read geometry (crop vs downscale)', () => {
  // The bug this pins: VideoFrame.copyTo({rect}) CROPS, it does not resize.
  // Reading with a 480x270 rect from a 1920x1080 frame returned the top-left
  // corner, while the reference path downscaled the whole picture -- so
  // detection compared a crop against a scaled whole and could never match.
  // Measured 61.3% against a 95% threshold, identical for all 12 references
  // because the mismatch was geometric rather than pictorial.
  //
  // Transcribed here because frame-source.js needs a real VideoFrame.
  const downscale = (src, sw, sh, dw, dh) => {
    const out = new Uint8ClampedArray(dw * dh * 4)
    const xr = sw / dw, yr = sh / dh
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, (y * yr) | 0)
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, (x * xr) | 0)
        const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4
        out[di] = src[si]; out[di + 1] = src[si + 1]
        out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
      }
    }
    return out
  }

  const crop = (src, sw, dw, dh) => {
    const out = new Uint8ClampedArray(dw * dh * 4)
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const si = (y * sw + x) * 4, di = (y * dw + x) * 4
        out[di] = src[si]; out[di + 1] = src[si + 1]
        out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
      }
    }
    return out
  }

  // A source whose top-left differs from the rest, like a letterboxed feed.
  const SW = 192, SH = 108
  const source = (() => {
    const d = new Uint8ClampedArray(SW * SH * 4)
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const i = (y * SW + x) * 4
        const inCorner = x < SW / 4 && y < SH / 4
        d[i] = inCorner ? 20 : 200
        d[i + 1] = inCorner ? 20 : 200
        d[i + 2] = inCorner ? 20 : 200
        d[i + 3] = 255
      }
    }
    return d
  })()

  it('downscaling preserves the whole picture, cropping does not', () => {
    const DW = 48, DH = 27
    const scaled = downscale(source, SW, SH, DW, DH)
    const cropped = crop(source, SW, DW, DH)

    // The crop lands entirely inside the dark corner.
    expect(cropped[0]).toBe(20)
    expect(cropped[(DH - 1) * DW * 4]).toBe(20)

    // The downscale sees both regions.
    const vals = new Set()
    for (let i = 0; i < scaled.length; i += 4) vals.add(scaled[i])
    expect(vals.has(20)).toBe(true)
    expect(vals.has(200)).toBe(true)
  })

  it('a downscaled read matches a downscaled reference; a cropped one does not', () => {
    const DW = 48, DH = 27
    const reference = { width: DW, height: DH, data: downscale(source, SW, SH, DW, DH) }
    const goodRead = { width: DW, height: DH, data: downscale(source, SW, SH, DW, DH) }
    const badRead = { width: DW, height: DH, data: crop(source, SW, DW, DH) }

    expect(matchRatio(goodRead, reference)).toBe(1)
    // The cropped read is the pre-fix behaviour: a partial match that can never
    // reach the threshold, exactly as observed on real hardware.
    expect(matchRatio(badRead, reference)).toBeLessThan(0.95)
  })
})
