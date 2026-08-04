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

// Stored reference screenshots for each device
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
  referenceScreenshots.set(deviceId, imageData)
  console.log(`[Detection] Saved reference screenshot for ${deviceId}: ${imageData.width}x${imageData.height}`)
}

/**
 * Check if a device has a reference screenshot
 * @param {string} deviceId - Device identifier
 * @returns {boolean}
 */
export function hasReferenceScreenshot(deviceId) {
  return referenceScreenshots.has(deviceId)
}

/**
 * Remove reference screenshot for a device
 * @param {string} deviceId - Device identifier
 */
export function clearReferenceScreenshot(deviceId) {
  referenceScreenshots.delete(deviceId)
  deviceStates.delete(deviceId)
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
  for (const [deviceId, imageData] of referenceScreenshots.entries()) {
    // Convert ImageData to base64 for storage
    canvas.width = imageData.width
    canvas.height = imageData.height
    ctx.putImageData(imageData, 0, 0)
    data[deviceId] = {
      dataUrl: canvas.toDataURL('image/png'),
      width: imageData.width,
      height: imageData.height
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
    try {
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = info.dataUrl
      })
      
      const canvas = document.createElement('canvas')
      canvas.width = info.width
      canvas.height = info.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, info.width, info.height)
      
      referenceScreenshots.set(deviceId, imageData)
      console.log(`[Detection] Restored reference screenshot for ${deviceId}`)
    } catch (err) {
      console.error(`[Detection] Failed to restore reference for ${deviceId}:`, err)
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
    
    // Use simple debouncing: need 2 consecutive matches to trigger
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
    
  } catch (err) {
    console.error('[Detection] Error during detection:', err)
    return state.lastResult
  }
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
