// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tests for the frame-source detection path (issue #61).
 *
 * The stakes here are asymmetric: detection failing "open" shows a no-signal
 * overlay over a live feed (annoying), while failing "closed" leaves a dead
 * feed looking live on the wall (the actual problem being solved). These cover
 * both directions, plus the reference resampling that makes reduced-size reads
 * comparable to full-resolution references.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkNoSignalFromSource, saveReferenceScreenshot, clearReferenceScreenshot,
  compareFrames, CONFIG,
} from '../src/renderer/detection-simple.js'

/** ImageData-shaped frame filled with one colour. */
function solid(width, height, [r, g, b]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
  }
  return { width, height, data }
}

/** Frame whose left half is one colour and right half another. */
function split(width, height, left, right) {
  const f = solid(width, height, left)
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width / 2); x < width; x++) {
      const i = (y * width + x) * 4
      f.data[i] = right[0]; f.data[i + 1] = right[1]; f.data[i + 2] = right[2]
    }
  }
  return f
}

/** Minimal frame source returning a fixed frame (or a queue of them). */
function sourceOf(...frames) {
  let i = 0
  return {
    calls: 0,
    async read() {
      this.calls++
      const f = frames[Math.min(i, frames.length - 1)]
      i++
      return f
    },
  }
}

const DEVICE = 'test-device'

beforeEach(() => {
  clearReferenceScreenshot(DEVICE)
})

describe('checkNoSignalFromSource', () => {
  it('reports no-signal when frames match the reference', async () => {
    saveReferenceScreenshot(DEVICE, solid(64, 36, [10, 10, 10]))
    const src = sourceOf(solid(64, 36, [10, 10, 10]))
    // Debounce needs two consecutive agreeing samples.
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(true)
  })

  it('reports signal present when frames differ from the reference', async () => {
    saveReferenceScreenshot(DEVICE, solid(64, 36, [10, 10, 10]))
    const src = sourceOf(solid(64, 36, [200, 200, 200]))
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
  })

  it('returns false with no reference saved, rather than guessing', async () => {
    const src = sourceOf(solid(64, 36, [0, 0, 0]))
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
  })

  it('holds the previous result when the source has no frame yet', async () => {
    saveReferenceScreenshot(DEVICE, solid(64, 36, [10, 10, 10]))
    const matching = sourceOf(solid(64, 36, [10, 10, 10]))
    await checkNoSignalFromSource(DEVICE, matching)
    await checkNoSignalFromSource(DEVICE, matching)
    expect(await checkNoSignalFromSource(DEVICE, matching)).toBe(true)

    // A startup gap must not flip the state back.
    const empty = { async read() { return null } }
    expect(await checkNoSignalFromSource(DEVICE, empty)).toBe(true)
  })

  it('holds the previous result when the source throws', async () => {
    saveReferenceScreenshot(DEVICE, solid(64, 36, [10, 10, 10]))
    const throwing = { async read() { throw new Error('track ended') } }
    // Never matched, so the held result is the initial false.
    expect(await checkNoSignalFromSource(DEVICE, throwing)).toBe(false)
  })

  it('requires two consecutive samples before flipping back to signal', async () => {
    saveReferenceScreenshot(DEVICE, solid(64, 36, [10, 10, 10]))
    const match = solid(64, 36, [10, 10, 10])
    const differ = solid(64, 36, [200, 200, 200])

    const s = sourceOf(match)
    await checkNoSignalFromSource(DEVICE, s)
    await checkNoSignalFromSource(DEVICE, s)
    expect(await checkNoSignalFromSource(DEVICE, s)).toBe(true)

    // One differing frame must not clear the overlay on its own.
    expect(await checkNoSignalFromSource(DEVICE, sourceOf(differ))).toBe(true)
    expect(await checkNoSignalFromSource(DEVICE, sourceOf(differ))).toBe(false)
  })
})

describe('reference resampling', () => {
  it('matches a downscaled read against a full-resolution reference', async () => {
    // The core of #61: references are captured at capture resolution, but the
    // WebCodecs source reads a smaller region. Without resampling these would
    // never compare equal and detection would never fire.
    saveReferenceScreenshot(DEVICE, solid(1920, 1080, [12, 12, 12]))
    const src = sourceOf(solid(480, 270, [12, 12, 12]))
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(true)
  })

  it('still distinguishes a different picture at reduced size', async () => {
    saveReferenceScreenshot(DEVICE, solid(1920, 1080, [12, 12, 12]))
    const src = sourceOf(solid(480, 270, [220, 30, 30]))
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
  })

  it('preserves spatial structure when downscaling', async () => {
    // A half-and-half reference must not be flattened into an average, or a
    // uniform frame of the mean colour would read as a match.
    saveReferenceScreenshot(DEVICE, split(1920, 1080, [0, 0, 0], [255, 255, 255]))
    const mean = sourceOf(solid(480, 270, [128, 128, 128]))
    expect(await checkNoSignalFromSource(DEVICE, mean)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, mean)).toBe(false)

    const structured = sourceOf(split(480, 270, [0, 0, 0], [255, 255, 255]))
    expect(await checkNoSignalFromSource(DEVICE, structured)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, structured)).toBe(true)
  })

  it('picks up a re-captured reference of the same dimensions', async () => {
    // Guards the cache-invalidation bug: a same-size re-capture must not keep
    // comparing against the old reference's pixels.
    saveReferenceScreenshot(DEVICE, solid(1920, 1080, [12, 12, 12]))
    const dark = sourceOf(solid(480, 270, [12, 12, 12]))
    await checkNoSignalFromSource(DEVICE, dark)
    expect(await checkNoSignalFromSource(DEVICE, dark)).toBe(true)

    // Re-capture with a different picture at the same dimensions. The same
    // dark frame must now stop matching -- if the stale downscale were reused
    // it would keep matching forever and the overlay would never clear.
    saveReferenceScreenshot(DEVICE, solid(1920, 1080, [200, 200, 200]))
    const stillDark = sourceOf(solid(480, 270, [12, 12, 12]))
    // No-signal is latched, so it takes two mismatches to clear (by design).
    expect(await checkNoSignalFromSource(DEVICE, stillDark)).toBe(true)
    expect(await checkNoSignalFromSource(DEVICE, stillDark)).toBe(false)
  })

  it('handles a reference smaller than the read size', async () => {
    saveReferenceScreenshot(DEVICE, solid(320, 180, [12, 12, 12]))
    const src = sourceOf(solid(480, 270, [12, 12, 12]))
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(false)
    expect(await checkNoSignalFromSource(DEVICE, src)).toBe(true)
  })
})

describe('compareFrames still agrees with the resampled path', () => {
  it('treats plain ImageData-shaped objects identically', () => {
    // The frame sources return plain objects, not real ImageData, so the
    // comparison must not depend on the ImageData prototype.
    const a = solid(32, 32, [100, 100, 100])
    const b = solid(32, 32, [100, 100, 100])
    expect(compareFrames(a, b)).toBe(true)
    expect(CONFIG.matchThreshold).toBeGreaterThan(0)
  })
})
