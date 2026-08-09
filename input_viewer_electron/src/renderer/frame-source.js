// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Frame sources for no-signal detection.
 *
 * Detection needs pixels from a capture track. There are two ways to get them:
 *
 *   canvas    ctx.drawImage(video) + ctx.getImageData()
 *             The original path. Works everywhere, but getImageData is a
 *             GPU->CPU readback of the whole frame -- 7.9 MiB at 1080p,
 *             31.6 MiB at 4K -- and issue #83 measured that readback, not the
 *             pixel comparison, as the dominant cost of a detection cycle.
 *
 *   webcodecs MediaStreamTrackProcessor -> VideoFrame -> copyTo()
 *             Reads frames straight off the track (issue #61). Copies only the
 *             region detection actually samples, so the transfer is a fraction
 *             of a full-frame readback, and no canvas is involved.
 *
 * The canvas path stays as the fallback: WebCodecs is feature-detected and any
 * failure downgrades rather than breaking detection. Detection failing "closed"
 * would leave a dead feed showing as live on the wall, so a working slow path
 * beats a broken fast one.
 */

/** Is the WebCodecs track-reading path usable in this runtime? */
export function supportsWebCodecsFrames() {
  return typeof MediaStreamTrackProcessor === 'function' && typeof VideoFrame === 'function'
}

/**
 * Downscale target for detection reads.
 *
 * Detection compares against a stored reference at the same size, and samples
 * every 4th pixel (CONFIG.sampleRate). It does not need native resolution: a
 * no-signal screen is a flat colour or a fixed card, both of which survive
 * heavy downscaling. Reading a small fixed region instead of the full frame is
 * what makes this path cheap, and keeps cost constant as capture resolution
 * grows.
 */
export const DETECT_WIDTH = 480
export const DETECT_HEIGHT = 270

/**
 * A frame source reading VideoFrames directly from a MediaStreamTrack.
 *
 * Frames arrive continuously from the track, but detection only samples every
 * ~1.6s. Rather than queue them (which would grow memory and hold GPU buffers
 * open), this keeps only the most recent frame and closes the previous one --
 * detection always sees current state, which is what it wants.
 */
export function createWebCodecsFrameSource(track) {
  // Reused across read() calls; see the note in read().
  let readBuffer = null      // downscaled output
  let fullBuffer = null      // full-resolution source
  if (!supportsWebCodecsFrames()) {
    throw new Error('WebCodecs frame reading is not available')
  }

  let latest = null
  let closed = false
  let reader = null

  const processor = new MediaStreamTrackProcessor({ track })
  reader = processor.readable.getReader()

  // Drain the track continuously. Without this the readable stalls and frames
  // stop arriving; the cost is one small object per frame, not a copy.
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || closed) {
          if (value) value.close()
          break
        }
        // Replacing rather than queueing: close the frame we are dropping, or
        // its GPU-backed buffer leaks.
        if (latest) latest.close()
        latest = value
      }
    } catch {
      // Track ended or was cancelled. Detection falls back to its last known
      // result, same as any other read failure.
    }
  })()

  return {
    /**
     * Most recent frame as ImageData-shaped pixels, or null if no frame has
     * arrived yet (device still starting up).
     * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}|null>}
     */
    async read() {
      if (closed || !latest) return null
      const frame = latest

      // Read the WHOLE frame, then downscale.
      //
      // copyTo's `rect` CROPS -- it does not resize. Passing a 480x270 rect
      // returned the top-left 480x270 pixels of a 1920x1080 frame, i.e. a
      // window onto the top-left eighth of the picture. The reference path
      // (captureScreenshot -> referenceAtSize) downscales the *full* frame, so
      // detection was comparing a crop against a scaled whole and could never
      // match: measured 61.3% against a 95% threshold, identical for every
      // stored reference because the mismatch is geometric, not pictorial.
      const srcW = frame.displayWidth || frame.codedWidth
      const srcH = frame.displayHeight || frame.codedHeight
      if (!srcW || !srcH) return null

      const fullSize = frame.allocationSize({ format: 'RGBA' })
      if (!fullBuffer || fullBuffer.length < fullSize) {
        fullBuffer = new Uint8ClampedArray(fullSize)
      }
      await frame.copyTo(fullBuffer, { format: 'RGBA' })

      // Target size: cap at the detect resolution but never upscale a source
      // that is already smaller.
      const w = Math.min(DETECT_WIDTH, srcW)
      const h = Math.min(DETECT_HEIGHT, srcH)

      // Nearest-neighbour downscale, matching referenceAtSize exactly so both
      // sides of the comparison sample the same way.
      const outSize = w * h * 4
      if (!readBuffer || readBuffer.length < outSize) {
        readBuffer = new Uint8ClampedArray(outSize)
      }
      const xRatio = srcW / w
      const yRatio = srcH / h
      for (let y = 0; y < h; y++) {
        const sy = Math.min(srcH - 1, (y * yRatio) | 0)
        const srcRow = sy * srcW
        const dstRow = y * w
        for (let x = 0; x < w; x++) {
          const sx = Math.min(srcW - 1, (x * xRatio) | 0)
          const si = (srcRow + sx) * 4
          const di = (dstRow + x) * 4
          readBuffer[di] = fullBuffer[si]
          readBuffer[di + 1] = fullBuffer[si + 1]
          readBuffer[di + 2] = fullBuffer[si + 2]
          readBuffer[di + 3] = fullBuffer[si + 3]
        }
      }
      // The consumer reads synchronously before the next cycle overwrites this,
      // which holds because detection awaits each read in turn and the loop
      // guards against overlapping cycles.
      return { width: w, height: h, data: readBuffer }
    },

    close() {
      closed = true
      if (latest) {
        latest.close()
        latest = null
      }
      // Cancelling the reader ends the drain loop above.
      try { reader.cancel() } catch { /* already ended */ }
    },
  }
}

/**
 * Fallback frame source: draw the video into a canvas and read it back.
 *
 * Same output shape as the WebCodecs source so callers do not branch. Reads at
 * the same reduced size for a like-for-like comparison, which also makes this
 * path cheaper than the original full-resolution readback.
 */
export function createCanvasFrameSource(video, canvas) {
  let ctx = null

  return {
    async read() {
      if (!video.srcObject || video.readyState < 2) return null

      const w = Math.min(DETECT_WIDTH, video.videoWidth || DETECT_WIDTH)
      const h = Math.min(DETECT_HEIGHT, video.videoHeight || DETECT_HEIGHT)
      if (!w || !h) return null

      if (!ctx) {
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }

      ctx.drawImage(video, 0, 0, w, h)
      const img = ctx.getImageData(0, 0, w, h)
      return { width: img.width, height: img.height, data: img.data }
    },

    close() {
      ctx = null
    },
  }
}

/**
 * Best available frame source for a video element, preferring WebCodecs.
 *
 * Falls back to the canvas path when WebCodecs is unavailable, when the element
 * has no live video track yet, or when processor construction throws.
 */
export function createFrameSource(video, canvas) {
  if (supportsWebCodecsFrames() && video.srcObject) {
    const [track] = video.srcObject.getVideoTracks?.() ?? []
    if (track && track.readyState === 'live') {
      try {
        return { kind: 'webcodecs', ...createWebCodecsFrameSource(track) }
      } catch {
        // Fall through to canvas.
      }
    }
  }
  return { kind: 'canvas', ...createCanvasFrameSource(video, canvas) }
}
