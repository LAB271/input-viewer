// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
import { describe, it, expect } from 'vitest'
import { compareFrames, CONFIG } from '../src/renderer/detection-simple.js'

// Build a minimal ImageData-like frame: { width, height, data }.
// `fill` may be a constant byte or a function (byteIndex) => byte.
function frame(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i++) {
    data[i] = typeof fill === 'function' ? fill(i) : fill
  }
  return { width, height, data }
}

describe('compareFrames (no-signal detection)', () => {
  it('treats identical frames as a match', () => {
    expect(compareFrames(frame(16, 16, 120), frame(16, 16, 120))).toBe(true)
  })

  it('treats frames differing well beyond the threshold as no match', () => {
    // every channel differs by 200 (>> pixelDifferenceThreshold of 30)
    expect(compareFrames(frame(16, 16, 0), frame(16, 16, 200))).toBe(false)
  })

  it('tolerates small per-channel differences within the threshold', () => {
    // diff of 20 per channel is <= threshold (30), so still a match
    expect(compareFrames(frame(16, 16, 100), frame(16, 16, 120))).toBe(true)
  })

  it('returns false when dimensions differ', () => {
    expect(compareFrames(frame(16, 16, 0), frame(8, 8, 0))).toBe(false)
  })

  it('falls below the match ratio when half the frame changes', () => {
    const half = data => data // readability alias
    const base = frame(16, 16, 100)
    // second half of the buffer differs by 100 (> threshold) -> ~50% match < 95%
    const changed = frame(16, 16, i => (i < base.data.length / 2 ? 100 : 200))
    expect(compareFrames(base, half(changed))).toBe(false)
  })

  it('exposes tunable CONFIG thresholds', () => {
    expect(CONFIG.pixelDifferenceThreshold).toBeTypeOf('number')
    expect(CONFIG.matchThreshold).toBeGreaterThan(0)
    expect(CONFIG.matchThreshold).toBeLessThanOrEqual(1)
  })
})

// Build a frame from a per-pixel colour function: (pixelIndex) => [r, g, b].
function pixelFrame(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const [r, g, b] = colorAt(p)
    data[p * 4] = r
    data[p * 4 + 1] = g
    data[p * 4 + 2] = b
    data[p * 4 + 3] = 255
  }
  return { width, height, data }
}

// A frame where the first `pct`% of pixels differ from a flat grey reference.
// `channel` limits the difference to one channel; undefined changes all three.
function partiallyChanged(width, height, pct, channel) {
  const cutoff = Math.floor((width * height * pct) / 100)
  return pixelFrame(width, height, p => {
    if (p >= cutoff) return [100, 100, 100]
    const px = [100, 100, 100]
    if (channel === undefined) return [200, 200, 200]
    px[channel] = 200
    return px
  })
}

// compareFrames bails out as soon as the miss count makes reaching
// matchThreshold impossible. These pin the verdict at and around that
// boundary so the optimisation can't silently change behaviour.
describe('compareFrames early-exit boundary', () => {
  const W = 50
  const H = 40
  const reference = pixelFrame(W, H, () => [100, 100, 100])

  it('still matches when the changed fraction stays under the tolerance', () => {
    // 95% match threshold -> up to ~5% of samples may miss
    expect(compareFrames(reference, partiallyChanged(W, H, 3))).toBe(true)
  })

  it('does not match once the changed fraction exceeds the tolerance', () => {
    expect(compareFrames(reference, partiallyChanged(W, H, 8))).toBe(false)
  })

  for (const channel of [0, 1, 2]) {
    it(`counts a miss when only channel ${channel} differs`, () => {
      // Exercises the per-channel early-exit paths: a miss on R or G must be
      // budgeted the same as a miss on B, not skipped over.
      expect(compareFrames(reference, partiallyChanged(W, H, 3, channel))).toBe(true)
      expect(compareFrames(reference, partiallyChanged(W, H, 20, channel))).toBe(false)
    })
  }

  it('does not exit early when the differing pixels are at the end of the buffer', () => {
    // Guards against a premature bail-out: everything matches until the final
    // 3% of pixels, which is still within tolerance, so this must be a match.
    const total = W * H
    const start = total - Math.floor(total * 0.03)
    const tailChanged = pixelFrame(W, H, p => (p >= start ? [250, 10, 10] : [100, 100, 100]))
    expect(compareFrames(reference, tailChanged)).toBe(true)
  })

  it('scans fully to confirm a match on an identical (no-signal) frame', () => {
    const identical = pixelFrame(W, H, () => [100, 100, 100])
    expect(compareFrames(reference, identical)).toBe(true)
  })
})
