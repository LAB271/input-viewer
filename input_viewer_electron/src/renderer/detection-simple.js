// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
// =============================================================================
// Simple No-Signal Detection Module
// Screenshot-based detection without OpenCV
// =============================================================================

export const CONFIG = {
  // Pixel comparison threshold (0-255 per channel)
  pixelDifferenceThreshold: 30,

  // Percentage of pixels that must match (0.0 - 1.0)
  matchThreshold: 0.95, // 95% of pixels must match

  // Sample every N pixels for faster comparison
  sampleRate: 4, // Check every 4th pixel

  // Debug logging
  debugLogging: false
}

// Diagnostic sink: when set, detection writes a per-cycle report here instead
// of to the console. Temporary, for the no-signal investigation.
let diagSink = null

/** @param {((line: string) => void)|null} fn */
export function setDiagnosticSink(fn) { diagSink = fn }

// Cheap-probe sizing. See probeFrames() for why 32.
const PROBE_POINTS = 32
// Allowed probe misses before rejecting. ~15% of the points, so a reference
// that matches loosely still reaches the full scan that decides properly.
const PROBE_MAX_MISSES = 5

// Stored reference screenshots per device: Map<deviceId, ImageData[]>.
//
// A list rather than a single image because one capture card has several
// no-signal states -- no cable, unsupported mode, HDCP error -- and each looks
// different. A frame matching ANY stored reference is no-signal, so an operator
// teaches the app each variant their hardware produces (issue #161).
const referenceScreenshots = new Map()

// Detection state per device
const deviceStates = new Map()

// Cached canvas contexts (avoids repeated getContext calls)
const canvasContextCache = new WeakMap()

// =============================================================================
// Setup and Configuration
// =============================================================================

/**
 * Save a reference screenshot for a device
 * @param {string} deviceId - Device identifier
 * @param {ImageData} imageData - Screenshot to use as reference
 */
export function saveReferenceScreenshot(deviceId, imageData) {
  const list = referenceScreenshots.get(deviceId) || []
  list.push(imageData)
  referenceScreenshots.set(deviceId, list)
  // Drop any cached downscales: they are keyed per device, and the new entry
  // shifts the indices the cache is built against.
  clearScaledCache(deviceId)
  console.log(`[Detection] Saved reference ${list.length} for ${deviceId}: ${imageData.width}x${imageData.height}`)
}

/**
 * Replace all references for a device with a single one.
 *
 * The pre-#161 behaviour, kept for callers that mean "reset to just this".
 * @param {string} deviceId
 * @param {ImageData} imageData
 */
export function replaceReferenceScreenshots(deviceId, imageData) {
  referenceScreenshots.set(deviceId, [imageData])
  clearScaledCache(deviceId)
  console.log(`[Detection] Replaced references for ${deviceId}`)
}

/**
 * Remove one reference by index.
 * @param {string} deviceId
 * @param {number} index
 * @returns {boolean} whether an entry was removed
 */
export function removeReferenceScreenshot(deviceId, index) {
  const list = referenceScreenshots.get(deviceId)
  if (!list || index < 0 || index >= list.length) return false
  list.splice(index, 1)
  if (list.length === 0) referenceScreenshots.delete(deviceId)
  clearScaledCache(deviceId)
  return true
}

/**
 * All references for a device.
 * @param {string} deviceId
 * @returns {ImageData[]} empty when none are stored
 */
export function getReferenceScreenshots(deviceId) {
  return referenceScreenshots.get(deviceId) || []
}

/**
 * Check if a device has a reference screenshot
 * @param {string} deviceId - Device identifier
 * @returns {boolean}
 */
export function hasReferenceScreenshot(deviceId) {
  const list = referenceScreenshots.get(deviceId)
  return Boolean(list && list.length > 0)
}

/**
 * Remove reference screenshot for a device
 * @param {string} deviceId - Device identifier
 */
export function clearReferenceScreenshot(deviceId) {
  referenceScreenshots.delete(deviceId)
  deviceStates.delete(deviceId)
  clearScaledCache(deviceId)
  console.log(`[Detection] Cleared reference screenshot for ${deviceId}`)
}

/**
 * Get all device IDs with reference screenshots
 * @returns {string[]}
 */
export function getConfiguredDevices() {
  return Array.from(referenceScreenshots.keys())
}

/**
 * Save reference screenshots to settings
 * @returns {object} Serializable reference data
 */
export function serializeReferences() {
  const data = {}
  // Reuse single canvas for all serializations (avoids repeated canvas creation)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  for (const [deviceId, list] of referenceScreenshots.entries()) {
    data[deviceId] = {
      // Written as a list from #161 on. deserializeReferences still reads the
      // old single-object shape, so an existing settings.json keeps working.
      references: list.map((imageData) => {
        canvas.width = imageData.width
        canvas.height = imageData.height
        ctx.putImageData(imageData, 0, 0)
        return {
          dataUrl: canvas.toDataURL('image/png'),
          width: imageData.width,
          height: imageData.height
        }
      })
    }
  }
  return data
}

/**
 * Load reference screenshots from settings
 * @param {object} data - Serialized reference data
 */
export async function deserializeReferences(data) {
  for (const [deviceId, info] of Object.entries(data)) {
    // Two shapes are accepted. Pre-#161 settings.json stored ONE reference per
    // device as a bare {dataUrl,width,height}; from #161 it is {references:[...]}.
    // Reading both means an existing install migrates with no user action, and
    // the first save rewrites it in the new shape.
    const entries = Array.isArray(info?.references)
      ? info.references
      : (info?.dataUrl ? [info] : [])

    const decoded = []
    for (const entry of entries) {
      try {
        const img = new Image()
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = entry.dataUrl
        })

        const canvas = document.createElement('canvas')
        canvas.width = entry.width
        canvas.height = entry.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        decoded.push(ctx.getImageData(0, 0, entry.width, entry.height))
      } catch (err) {
        // One bad entry must not discard the device's other references.
        console.error(`[Detection] Failed to restore a reference for ${deviceId}:`, err)
      }
    }

    if (decoded.length > 0) {
      referenceScreenshots.set(deviceId, decoded)
      clearScaledCache(deviceId)
      console.log(`[Detection] Restored ${decoded.length} reference(s) for ${deviceId}`)
    }
  }
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Get or create state for a device
 * @param {string} deviceId 
 * @returns {object}
 */
function getDeviceState(deviceId) {
  if (!deviceStates.has(deviceId)) {
    deviceStates.set(deviceId, {
      lastResult: false,
      matchCount: 0,
      noMatchCount: 0
    })
  }
  return deviceStates.get(deviceId)
}

/**
 * Check if current video frame matches the no-signal reference
 * @param {string} deviceId - Device identifier
 * @param {HTMLVideoElement} video - Video element to check
 * @param {HTMLCanvasElement} canvas - Canvas for frame capture
 * @returns {boolean} - True if no-signal detected
 */
export function checkNoSignal(deviceId, video, canvas) {
  // Check if we have a reference screenshot
  const reference = referenceScreenshots.get(deviceId)
  if (!reference) {
    if (CONFIG.debugLogging) console.log(`[Detection] No reference screenshot for ${deviceId}`)
    return false
  }

  const state = getDeviceState(deviceId)

  try {
    // Get or create cached canvas context (avoids repeated getContext calls)
    let ctx = canvasContextCache.get(canvas)
    if (!ctx) {
      ctx = canvas.getContext('2d', { willReadFrequently: true })
      canvasContextCache.set(canvas, ctx)
    }

    // Only resize canvas when dimensions actually change (avoids GPU buffer reallocation)
    const targetWidth = video.videoWidth || 640
    const targetHeight = video.videoHeight || 480
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }

    if (canvas.width === 0 || canvas.height === 0) {
      return state.lastResult
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    
    // Compare frames
    const isMatch = compareFrames(currentFrame, reference)
    
    if (CONFIG.debugLogging) {
      console.log(`[Detection] ${deviceId}: ${isMatch ? 'MATCH (no signal)' : 'NO MATCH (has signal)'}`)
    }
    
    return applyDebounce(state, isMatch)

  } catch (err) {
    console.error('[Detection] Error during detection:', err)
    return state.lastResult
  }
}

// Resampled references, keyed by deviceId. A reference is captured once at
// capture resolution but compared against every detection cycle at detect
// resolution, so the downscale is cached rather than repeated.
//
// Keyed `deviceId#refIndex`, not by device: with a list of references, keying
// by device alone would make each reference evict the previous one on every
// cycle, so the downscale would be recomputed for all of them every time.
const scaledReferenceCache = new Map()

/** Drop every cached downscale belonging to a device. */
function clearScaledCache(deviceId) {
  const prefix = `${deviceId}#`
  for (const key of scaledReferenceCache.keys()) {
    if (key.startsWith(prefix)) scaledReferenceCache.delete(key)
  }
}

/**
 * A device's reference screenshot resampled to the given size.
 *
 * Nearest-neighbour rather than a smooth filter, deliberately: detection asks
 * "are these the same picture", and interpolation would blur a sharp no-signal
 * card toward its background, shifting pixel values away from what the live
 * frame produces. Nearest-neighbour keeps the sampled values as they were.
 *
 * @param {string} deviceId
 * @param {ImageData} reference
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, data: Uint8ClampedArray}|null}
 */
export function referenceAtSize(deviceId, refIndex, reference, width, height) {
  if (!width || !height) return null

  // Already the right size: use as-is.
  if (reference.width === width && reference.height === height) return reference

  const cacheKey = `${deviceId}#${refIndex}`
  const cached = scaledReferenceCache.get(cacheKey)
  if (cached && cached.width === width && cached.height === height &&
      cached.sourceWidth === reference.width && cached.sourceHeight === reference.height) {
    return cached.frame
  }

  const src = reference.data
  const out = new Uint8ClampedArray(width * height * 4)
  const xRatio = reference.width / width
  const yRatio = reference.height / height

  for (let y = 0; y < height; y++) {
    const sy = Math.min(reference.height - 1, (y * yRatio) | 0)
    const srcRow = sy * reference.width
    const dstRow = y * width
    for (let x = 0; x < width; x++) {
      const sx = Math.min(reference.width - 1, (x * xRatio) | 0)
      const s = (srcRow + sx) * 4
      const d = (dstRow + x) * 4
      out[d] = src[s]
      out[d + 1] = src[s + 1]
      out[d + 2] = src[s + 2]
      out[d + 3] = src[s + 3]
    }
  }

  const frame = { width, height, data: out }
  scaledReferenceCache.set(cacheKey, {
    width, height, sourceWidth: reference.width, sourceHeight: reference.height, frame,
  })
  return frame
}

/**
 * Fold a single comparison into a device's debounced result.
 *
 * Two consecutive agreeing samples are required before the reported state
 * flips, so one bad frame (a decode hiccup, a mid-resize capture) cannot
 * blank a live feed or clear a genuine no-signal overlay.
 *
 * @param {object} state - Per-device detection state
 * @param {boolean} isMatch - Whether this frame matched the reference
 * @returns {boolean} - The debounced no-signal result
 */
function applyDebounce(state, isMatch) {
  if (isMatch) {
    state.matchCount++
    state.noMatchCount = 0
    if (state.matchCount >= 2) {
      state.lastResult = true
    }
  } else {
    state.noMatchCount++
    state.matchCount = 0
    if (state.noMatchCount >= 2) {
      state.lastResult = false
    }
  }
  return state.lastResult
}

/**
 * Check for no-signal using a frame source instead of a video element.
 *
 * Same semantics as checkNoSignal -- same comparison, same debounce, same
 * reference screenshots -- but the pixels come from whatever source is
 * supplied. That lets the WebCodecs path (issue #61) avoid the canvas
 * readback getImageData forces, while the canvas source keeps the original
 * behaviour available as a fallback.
 *
 * References are captured at full capture resolution, but sources read at a
 * reduced detect size, so the two would never match on dimensions. The
 * reference is therefore resampled to the frame's size on first use and cached,
 * which keeps every already-saved reference working -- no re-capture needed.
 *
 * @param {string} deviceId - Device identifier
 * @param {{read: () => Promise<{width: number, height: number, data: Uint8ClampedArray}|null>}} source
 * @returns {Promise<boolean>} - True if no-signal detected
 */
export async function checkNoSignalFromSource(deviceId, source) {
  const references = referenceScreenshots.get(deviceId)
  if (!references || references.length === 0) {
    if (CONFIG.debugLogging) console.log(`[Detection] No reference screenshot for ${deviceId}`)
    return false
  }

  const state = getDeviceState(deviceId)

  try {
    const frame = await source.read()
    // No frame yet (device still starting) is not evidence either way, so hold
    // the previous result rather than reporting a spurious change.
    if (!frame) return state.lastResult

    // A frame matching ANY stored reference is no-signal: a capture card has
    // several such screens (no cable, unsupported mode, HDCP error) and the
    // operator captures each one (issue #161).
    //
    // Staged per reference, cheapest first. The probe rejects a live feed in
    // ~32 comparisons, so the common case costs 32*N rather than 32,400*N --
    // which is what keeps a list of references affordable.
    let isMatch = false
    let matchedIndex = -1
    const trace = []
    for (let i = 0; i < references.length; i++) {
      const scaled = referenceAtSize(deviceId, i, references[i], frame.width, frame.height)
      if (!scaled) { trace.push(`#${i} scale-failed`); continue }
      const probed = probeFrames(frame, scaled)
      if (!probed) {
        trace.push(`#${i} ${references[i].width}x${references[i].height} probe-rejected ` +
          `ratio=${matchRatio(frame, scaled).toFixed(3)}`)
        continue
      }
      const full = compareFrames(frame, scaled)
      trace.push(`#${i} ${references[i].width}x${references[i].height} probe-ok ` +
        `ratio=${matchRatio(frame, scaled).toFixed(3)} match=${full}`)
      if (full) { isMatch = true; matchedIndex = i; break }
    }
    if (diagSink) {
      diagSink(`compare frame=${frame.width}x${frame.height} need=${CONFIG.matchThreshold}`)
      for (const t of trace) diagSink('  ' + t)
      const scaled0 = referenceAtSize(deviceId, 0, references[0], frame.width, frame.height)
      if (scaled0) {
        // Raw pixels from both sides. Identical match ratios across
        // independent captures point at a structural difference -- channel
        // order, premultiplied alpha, or a reference that never held the
        // picture -- rather than at the images genuinely differing.
        const at = (buf, px) => `[${buf[px * 4]},${buf[px * 4 + 1]},${buf[px * 4 + 2]},${buf[px * 4 + 3]}]`
        const pts = [0, 1000, 30000, 64800, 100000]
        diagSink('  frame px: ' + pts.map((p) => at(frame.data, p)).join(' '))
        diagSink('  ref   px: ' + pts.map((p) => at(scaled0.data, p)).join(' '))
        // Channel-swap check: does matching R against B score better?
        let asIs = 0, swapped = 0, n = 0
        for (let px = 0; px < frame.width * frame.height; px += 97) {
          const o = px * 4
          const fr = frame.data[o], fg = frame.data[o + 1], fb = frame.data[o + 2]
          const rr = scaled0.data[o], rg = scaled0.data[o + 1], rb = scaled0.data[o + 2]
          const th = CONFIG.pixelDifferenceThreshold
          const near = (a, b) => (a - b < 0 ? b - a : a - b) <= th
          if (near(fr, rr) && near(fg, rg) && near(fb, rb)) asIs++
          if (near(fr, rb) && near(fg, rg) && near(fb, rr)) swapped++
          n++
        }
        diagSink(`  ratio as-is=${(asIs / n).toFixed(3)} rgb-swapped=${(swapped / n).toFixed(3)}` +
          (swapped > asIs * 1.2 ? '   <-- CHANNEL ORDER MISMATCH' : ''))
      }
    }

    if (CONFIG.debugLogging) {
      console.log(`[Detection] ${deviceId}: ${isMatch
        ? `MATCH (no signal, reference ${matchedIndex + 1}/${references.length})`
        : `NO MATCH (has signal, ${references.length} reference(s) checked)`}`)
    }

    return applyDebounce(state, isMatch)

  } catch (err) {
    console.error('[Detection] Error during detection:', err)
    return state.lastResult
  }
}


/**
 * Cheap probe: does this frame plausibly match the reference?
 *
 * Samples PROBE_POINTS pixels spread across the frame and rejects early if too
 * many differ. A live feed differs from a no-signal reference almost
 * everywhere, so this exits in microseconds instead of scanning 32,400 samples
 * -- which is the work that made detection visibly hitch, once per device per
 * cycle, and which multiplies by the number of stored references.
 *
 * **The probe must never reject a frame the full scan would have matched.** A
 * false pass only costs a scan that was going to happen anyway; a false reject
 * silently breaks detection. Hence the deliberately generous miss budget: it
 * only bails when a mismatch is obvious.
 *
 * PROBE_POINTS = 32 is chosen by measurement. Probability a live feed wrongly
 * passes the probe, in the hard case where only 30% of pixels differ:
 *
 *   5 points  -> 16.8%
 *   16 points ->  9.9%
 *   32 points ->  1.9%
 *
 * A wrong pass is harmless but wastes a scan, and 32 comparisons is nothing
 * against 32,400.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} frame
 * @param {{width:number,height:number,data:Uint8ClampedArray}} reference same size
 * @returns {boolean} true when the full scan is worth running
 */
export function probeFrames(frame, reference) {
  const a = frame.data
  const b = reference.data
  const pixels = frame.width * frame.height
  if (pixels === 0) return false

  const threshold = CONFIG.pixelDifferenceThreshold
  let misses = 0

  for (let i = 0; i < PROBE_POINTS; i++) {
    // Golden-ratio stride spreads the points across the whole frame without
    // clustering, and is deterministic -- the same offsets every cycle, so the
    // reads stay cache-predictable.
    const px = Math.floor(((i * 0.6180339887) % 1) * pixels)
    const o = px * 4

    const dr = a[o] - b[o]
    const dg = a[o + 1] - b[o + 1]
    const db = a[o + 2] - b[o + 2]
    if ((dr < 0 ? -dr : dr) > threshold ||
        (dg < 0 ? -dg : dg) > threshold ||
        (db < 0 ? -db : db) > threshold) {
      if (++misses > PROBE_MAX_MISSES) return false
    }
  }
  return true
}

/**
 * Compare two image frames
 * @param {ImageData} frame1 - Current frame
 * @param {ImageData} frame2 - Reference frame
 * @returns {boolean} - True if frames match
 */
export function compareFrames(frame1, frame2) {
  // If dimensions don't match, resize comparison
  if (frame1.width !== frame2.width || frame1.height !== frame2.height) {
    if (CONFIG.debugLogging) {
      console.log(`[Detection] Frame size mismatch: ${frame1.width}x${frame1.height} vs ${frame2.width}x${frame2.height}`)
    }
    // For now, if sizes don't match, it's not a match
    return false
  }

  const data1 = frame1.data
  const data2 = frame2.data
  const stride = 4 * CONFIG.sampleRate
  const threshold = CONFIG.pixelDifferenceThreshold
  const len = data1.length

  // Total samples the loop below would take, and the number of misses past
  // which a match becomes arithmetically impossible. Once more than
  // (1 - matchThreshold) of the samples have missed, the final ratio cannot
  // reach the threshold no matter how every remaining pixel compares, so
  // scanning on is wasted work. The live-signal case (frames differ) blows
  // the budget almost immediately; the no-signal case still scans fully,
  // which is correct since a match has to be proven.
  const totalSamples = Math.ceil(len / stride)
  const maxMisses = totalSamples - Math.ceil(totalSamples * CONFIG.matchThreshold)

  let sampledPixels = 0
  let matchingPixels = 0
  let misses = 0

  // Optimized pixel sampling with inline abs calculation (avoids Math.abs function calls)
  for (let i = 0; i < len; i += stride) {
    sampledPixels++

    // Inline absolute difference without Math.abs (faster). A sample counts
    // as matching only when R, G and B all pass; any channel failing is a
    // miss and trips the early-exit budget.
    let d = data1[i] - data2[i]
    if ((d < 0 ? -d : d) > threshold) {
      if (++misses > maxMisses) return false
      continue
    }

    d = data1[i + 1] - data2[i + 1]
    if ((d < 0 ? -d : d) > threshold) {
      if (++misses > maxMisses) return false
      continue
    }

    d = data1[i + 2] - data2[i + 2]
    if ((d < 0 ? -d : d) <= threshold) {
      matchingPixels++
    } else if (++misses > maxMisses) {
      return false
    }
  }

  const matchRatio = matchingPixels / sampledPixels

  if (CONFIG.debugLogging) {
    console.log(`[Detection] Match ratio: ${(matchRatio * 100).toFixed(1)}% (need ${CONFIG.matchThreshold * 100}%)`)
  }

  return matchRatio >= CONFIG.matchThreshold
}

/**
 * Capture a screenshot from a video element
 * @param {HTMLVideoElement} video - Video element
 * @param {HTMLCanvasElement} canvas - Canvas for capture
 * @returns {ImageData|null} - Captured frame data
 */
export function captureScreenshot(video, canvas) {
  try {
    // Use willReadFrequently hint to optimize for getImageData calls
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480

    if (canvas.width === 0 || canvas.height === 0) {
      console.error('[Detection] Cannot capture screenshot: invalid video dimensions')
      return null
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    console.log(`[Detection] Captured screenshot: ${imageData.width}x${imageData.height}`)
    return imageData
  } catch (err) {
    console.error('[Detection] Error capturing screenshot:', err)
    return null
  }
}

/**
 * Enable/disable debug logging
 * @param {boolean} enabled
 */
export function setDebugLogging(enabled) {
  CONFIG.debugLogging = enabled
  console.log(`[Detection] Debug logging ${enabled ? 'enabled' : 'disabled'}`)
}

/**
 * Check if detection system is ready for a device
 * @param {string} deviceId - Device identifier
 * @returns {boolean}
 */
export function isReady(deviceId) {
  return referenceScreenshots.has(deviceId)
}

/**
 * The match ratio compareFrames computes internally, without the early exit.
 *
 * compareFrames returns a boolean and bails as soon as a match is
 * arithmetically impossible, which is right for the hot path but useless for
 * diagnosis -- "false" does not say whether a frame missed by 1% or 90%. This
 * always scans fully and returns the number, so a near-miss is visible.
 *
 * Diagnostics only; the detection path uses compareFrames.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} frame
 * @param {{width:number,height:number,data:Uint8ClampedArray}} reference
 * @returns {number} fraction of sampled pixels that matched, 0..1
 */
export function matchRatio(frame, reference) {
  if (frame.width !== reference.width || frame.height !== reference.height) return 0
  const a = frame.data
  const b = reference.data
  const stride = 4 * CONFIG.sampleRate
  const threshold = CONFIG.pixelDifferenceThreshold
  let sampled = 0
  let matching = 0
  for (let i = 0; i < a.length; i += stride) {
    sampled++
    const dr = a[i] - b[i]
    if ((dr < 0 ? -dr : dr) > threshold) continue
    const dg = a[i + 1] - b[i + 1]
    if ((dg < 0 ? -dg : dg) > threshold) continue
    const db = a[i + 2] - b[i + 2]
    if ((db < 0 ? -db : db) > threshold) continue
    matching++
  }
  return sampled === 0 ? 0 : matching / sampled
}
