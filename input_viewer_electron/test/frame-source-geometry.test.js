// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The WebCodecs frame source's read geometry.
 *
 * This exercises the REAL createWebCodecsFrameSource against a fake VideoFrame,
 * rather than transcribing its logic. That distinction is the whole point: the
 * bug it guards shipped while transcribed tests passed, because a transcription
 * of the intended behaviour cannot fail when the implementation disagrees
 * with it.
 *
 * The bug: VideoFrame.copyTo({rect}) CROPS, it does not resize. Reading with a
 * 480x270 rect from a 1920x1080 frame returned the top-left corner of the
 * picture, while the reference path (captureScreenshot -> referenceAtSize)
 * downscaled the whole frame. Detection therefore compared a crop against a
 * scaled whole and could never match -- measured 61.3% against a 95%
 * threshold, and identically for every stored reference, because the mismatch
 * was geometric rather than pictorial.
 *
 * A frame source must return the WHOLE picture, downscaled -- never a crop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const SRC_W = 1920
const SRC_H = 1080

/**
 * A test image whose top-left eighth is dark and whose remainder is bright.
 *
 * Chosen so a crop and a downscale are trivially distinguishable: a crop of the
 * top-left region sees only dark pixels, while a downscale of the whole frame
 * sees both. A uniform image would pass either way, which is exactly how the
 * real bug hid.
 */
function makeSourcePixels() {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4)
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const i = (y * SRC_W + x) * 4
      const dark = x < SRC_W / 4 && y < SRC_H / 4
      data[i] = dark ? 20 : 220
      data[i + 1] = dark ? 20 : 220
      data[i + 2] = dark ? 20 : 220
      data[i + 3] = 255
    }
  }
  return data
}

const SOURCE = makeSourcePixels()

/** Minimal VideoFrame stand-in implementing the parts read() uses. */
class FakeVideoFrame {
  constructor() {
    this.displayWidth = SRC_W
    this.displayHeight = SRC_H
    this.codedWidth = SRC_W
    this.codedHeight = SRC_H
    this.closed = false
  }

  allocationSize(options = {}) {
    const r = options.rect
    return r ? r.width * r.height * 4 : SRC_W * SRC_H * 4
  }

  /** Honours `rect` as a CROP, exactly as the real API does. */
  async copyTo(dest, options = {}) {
    const r = options.rect || { x: 0, y: 0, width: SRC_W, height: SRC_H }
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const si = ((y + r.y) * SRC_W + (x + r.x)) * 4
        const di = (y * r.width + x) * 4
        dest[di] = SOURCE[si]
        dest[di + 1] = SOURCE[si + 1]
        dest[di + 2] = SOURCE[si + 2]
        dest[di + 3] = SOURCE[si + 3]
      }
    }
  }

  close() { this.closed = true }
}

let originalProcessor
let originalVideoFrame

beforeEach(() => {
  originalProcessor = globalThis.MediaStreamTrackProcessor
  originalVideoFrame = globalThis.VideoFrame

  // A processor whose readable yields one frame and then parks, matching the
  // real drain loop's shape without ending the stream.
  globalThis.MediaStreamTrackProcessor = class {
    constructor() {
      let delivered = false
      this.readable = {
        getReader: () => ({
          read: async () => {
            if (delivered) return new Promise(() => {}) // never resolves
            delivered = true
            return { value: new FakeVideoFrame(), done: false }
          },
          cancel: () => {}
        })
      }
    }
  }
  globalThis.VideoFrame = FakeVideoFrame
})

afterEach(() => {
  globalThis.MediaStreamTrackProcessor = originalProcessor
  globalThis.VideoFrame = originalVideoFrame
})

/** Let the drain loop deliver its first frame. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createWebCodecsFrameSource read geometry', () => {
  it('returns the whole picture downscaled, not a crop of it', async () => {
    const { createWebCodecsFrameSource } = await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    await settle()

    const frame = await source.read()
    expect(frame).not.toBeNull()

    // Both regions of the source must be represented. A crop of the top-left
    // would contain only the dark value -- that is the shipped bug.
    const values = new Set()
    for (let i = 0; i < frame.data.length; i += 4) values.add(frame.data[i])
    expect(values.has(20), 'downscale should include the dark corner').toBe(true)
    expect(values.has(220), 'downscale should include the bright remainder').toBe(true)

    source.close()
  })

  it('caps at the detect size without upscaling a smaller source', async () => {
    const { createWebCodecsFrameSource, DETECT_WIDTH, DETECT_HEIGHT } =
      await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    await settle()

    const frame = await source.read()
    expect(frame.width).toBe(DETECT_WIDTH)
    expect(frame.height).toBe(DETECT_HEIGHT)
    expect(frame.data.length).toBeGreaterThanOrEqual(DETECT_WIDTH * DETECT_HEIGHT * 4)

    source.close()
  })

  it('samples proportionally, so the dark corner occupies a quarter of each axis', async () => {
    const { createWebCodecsFrameSource } = await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    await settle()

    const frame = await source.read()
    // The source's dark region is the top-left quarter of each axis, so a
    // correct downscale reproduces that proportion. A crop would be all dark;
    // a stretched read would put the boundary somewhere else entirely.
    let darkPixels = 0
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i] < 128) darkPixels++
    }
    const darkFraction = darkPixels / (frame.width * frame.height)
    expect(darkFraction).toBeGreaterThan(0.05)
    expect(darkFraction).toBeLessThan(0.10)

    source.close()
  })

  it('returns null before any frame has arrived', async () => {
    const { createWebCodecsFrameSource } = await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    // Deliberately no settle(): the drain loop has not delivered yet.
    expect(await source.read()).toBeNull()
    source.close()
  })

  it('returns null once closed', async () => {
    const { createWebCodecsFrameSource } = await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    await settle()
    source.close()
    expect(await source.read()).toBeNull()
  })

  it('reuses its buffer across reads rather than reallocating', async () => {
    const { createWebCodecsFrameSource } = await import('../src/renderer/frame-source.js')
    const source = createWebCodecsFrameSource({})
    await settle()

    const first = await source.read()
    const second = await source.read()
    // Same backing array: the read path allocates once per source, not once
    // per detection cycle (~518KB otherwise, per device, every 1.6s).
    expect(second.data).toBe(first.data)

    source.close()
  })
})
