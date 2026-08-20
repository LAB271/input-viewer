// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Snapshot thumbnails for the dropdown input rows (#242).
 *
 * Snapshots, not live previews. The wall shows one or two feeds and the app holds
 * exactly two streams; four live previews would have meant rebuilding that, and
 * for a picker that is open for a few seconds it buys nothing. So the dropdown
 * takes a still of each input when it opens and iterates -- **at most one extra
 * stream is open at any moment**, which needs no change to how feeds are held.
 *
 * Where each still comes from matters:
 *
 *   active input    straight off the live <video> already showing it. No stream,
 *                   no negotiation, instant.
 *   inactive input  a temporary getUserMedia, released the moment a frame has
 *                   been drawn.
 *
 * A cold capture device takes a visible fraction of a second to negotiate, so the
 * sweep is sequential and asynchronous by nature: rows show a placeholder and
 * fill in as stills land. A device that never produces a frame times out and
 * stays a placeholder, which is also what an exclusive-access device does. That is
 * a normal outcome here, not an error.
 *
 * Stills are cached as data URLs keyed by deviceId. The row DOM is rebuilt on
 * every render, so a cached URL survives that where a canvas reference would not
 * -- and re-opening the dropdown shows the previous still immediately while a
 * fresh sweep replaces it, rather than flashing back to placeholders.
 */

/**
 * Thumbnail size, in pixels of stored image.
 *
 * 16:9 at 256 wide. Large enough to tell what an input is showing, small enough
 * that four of them as JPEG data URLs are a few KB each rather than a few hundred.
 * The row scales it with CSS; this is only the stored resolution.
 */
export const THUMB_WIDTH = 256
export const THUMB_HEIGHT = 144

/**
 * How long to wait for a frame from a freshly-opened device before giving up.
 *
 * Generous, because a capture card negotiating a mode is slow and a placeholder is
 * worse than a late thumbnail. Bounded, because the sweep is sequential and one
 * dead device must not hold up the rest of the row.
 */
export const FRAME_TIMEOUT_MS = 2500

/** JPEG rather than PNG: a video still compresses far better and nobody zooms in. */
const JPEG_QUALITY = 0.72

/**
 * Draw a video element into a data URL at thumbnail size.
 *
 * Returns null rather than throwing when the element has no decoded frame yet --
 * `videoWidth` of 0 means there is nothing to draw, and drawImage would silently
 * produce a blank rather than fail.
 *
 * @param {HTMLVideoElement} video
 * @returns {string|null} data URL
 */
export function snapshotFromVideo(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return null

  const canvas = document.createElement('canvas')
  canvas.width = THUMB_WIDTH
  canvas.height = THUMB_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Cover, not stretch: crop the long axis so a 16:9 capture and a 4:3 one both
  // fill the tile without distorting. A squashed preview is harder to recognise
  // than a cropped one.
  const srcAspect = video.videoWidth / video.videoHeight
  const dstAspect = THUMB_WIDTH / THUMB_HEIGHT
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight
  if (srcAspect > dstAspect) {
    sw = video.videoHeight * dstAspect
    sx = (video.videoWidth - sw) / 2
  } else if (srcAspect < dstAspect) {
    sh = video.videoWidth / dstAspect
    sy = (video.videoHeight - sh) / 2
  }

  try {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    // A tainted or not-yet-ready frame. Placeholder is the right answer.
    return null
  }
}

/**
 * Resolve once the element has a frame worth drawing, or on timeout.
 *
 * requestVideoFrameCallback is the accurate signal -- it fires per presented
 * frame. Where it is missing, poll readyState instead of assuming one rAF is
 * enough; a freshly-attached stream routinely needs more than one.
 *
 * @returns {Promise<boolean>} true if a frame arrived
 */
export function waitForFrame(video, timeoutMs = FRAME_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)

    if (video.videoWidth && video.readyState >= 2) return finish(true)

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => finish(true))
      return
    }
    const poll = () => {
      if (done) return
      if (video.videoWidth && video.readyState >= 2) return finish(true)
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  })
}

/**
 * Create the thumbnail store and sweep runner.
 *
 * Dependencies are injected rather than imported so the sweep is testable without
 * a capture device, a DOM video pipeline, or the renderer's module state.
 *
 * @param {object} deps
 * @param {() => Array<{deviceId: string, label: string}>} deps.listInputs
 *   enabled inputs, in the order the dropdown shows them
 * @param {(deviceId: string) => HTMLVideoElement|null} deps.liveVideoFor
 *   the element already showing this input, or null
 * @param {(deviceId: string, label: string) => Promise<{stream: MediaStream, stop: () => void}>}
 *   deps.openTemporaryStream
 * @param {(deviceId: string, dataUrl: string) => void} deps.onThumbnail
 *   called as each still lands, so rows can fill in progressively
 */
export function createThumbnailStore({
  listInputs,
  liveVideoFor,
  openTemporaryStream,
  onThumbnail,
}) {
  const cache = new Map()
  let sweeping = false
  let generation = 0

  /** Capture one input. Returns a data URL or null. */
  async function captureOne(device) {
    // Already on screen: no stream, no negotiation.
    const live = liveVideoFor(device.deviceId)
    if (live) {
      const url = snapshotFromVideo(live)
      if (url) return url
      // Fall through: the element exists but has no frame (still starting up).
    }

    let handle = null
    try {
      handle = await openTemporaryStream(device.deviceId, device.label)
      if (!handle) return null
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = handle.stream
      // play() can reject (autoplay policy, no frames); the wait below decides.
      try { await video.play() } catch { /* fall through to waitForFrame */ }
      const ok = await waitForFrame(video)
      const url = ok ? snapshotFromVideo(video) : null
      video.srcObject = null
      return url
    } catch {
      // Exclusive-access device, permission refusal, device unplugged mid-sweep.
      // All of these are placeholders rather than errors.
      return null
    } finally {
      if (handle) {
        try { handle.stop() } catch { /* already gone */ }
      }
    }
  }

  return {
    /** Cached still for a device, or null. */
    get(deviceId) {
      return cache.get(deviceId) ?? null
    },

    /** Every cached still, for painting freshly-rendered rows. */
    entries() {
      return [...cache.entries()]
    },

    /** True while a sweep is in flight. */
    get sweeping() {
      return sweeping
    },

    /**
     * Snapshot every enabled input, one at a time.
     *
     * A second call while one is running is ignored rather than queued: the
     * dropdown can be opened and closed repeatedly in the time a single cold
     * capture takes, and stacking sweeps would hold a stream open per repeat.
     */
    async sweep() {
      if (sweeping) return
      sweeping = true
      const mine = ++generation
      try {
        for (const device of listInputs()) {
          // A newer sweep (or a reset) supersedes this one.
          if (mine !== generation) return
          const url = await captureOne(device)
          if (mine !== generation) return
          if (url) {
            cache.set(device.deviceId, url)
            onThumbnail(device.deviceId, url)
          }
        }
      } finally {
        if (mine === generation) sweeping = false
      }
    },

    /** Drop everything, e.g. when the device list changes. */
    reset() {
      cache.clear()
      generation++
      sweeping = false
    },
  }
}
