// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Synthetic capture inputs for `--mock` (#248).
 *
 * These are real MediaStreams, from canvas.captureStream(), not a stub swapped
 * in front of the video elements. That choice is the whole point: a stub would
 * prove the UI renders, whereas a genuine stream flows through every stage the
 * production path uses -- srcObject, readyState, getVideoTracks(), the
 * MediaStreamTrackProcessor in frame-source.js, the downscale, the reference
 * comparison. Detection cannot tell a mock input from a capture card, so
 * exercising it against one is worth something.
 *
 * Each input draws SMPTE-ish colour bars with its own name and a sweeping bar,
 * so a glance at the wall says which input is showing and that it is live.
 * `still: true` freezes the pattern to a dark card, which is what a capture
 * card with nothing plugged into it actually looks like.
 */

/** Device ids are prefixed so mock inputs can never be mistaken for real ones. */
export const MOCK_DEVICE_PREFIX = 'mock-input-'

/** Native size of a mock input. Detection downscales to 480x270 regardless. */
export const MOCK_WIDTH = 1280
export const MOCK_HEIGHT = 720

/**
 * Frame rate of the synthetic streams.
 *
 * Low on purpose. Mock inputs exist to be looked at and detected, not to be
 * smooth, and on the 6000x1200 wall several animating canvases compete with the
 * screensaver for the same GPU. 15fps still reads unambiguously as moving.
 */
export const MOCK_FPS = 15

/** Is this a synthetic device id? */
export function isMockDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith(MOCK_DEVICE_PREFIX)
}

/**
 * Build a device list shaped like enumerateDevices() output.
 *
 * groupId differs per device deliberately. Real capture cards report one
 * groupId per physical device and the renderer pairs audio by it (#151); giving
 * every mock input the same groupId would make that pairing look correct in
 * mock mode while being wrong for hardware.
 *
 * @param {number} count how many inputs to synthesise
 * @returns {Array<{deviceId: string, kind: string, label: string, groupId: string}>}
 */
export function mockDeviceList(count) {
  const n = Math.max(1, Math.floor(count) || 1)
  return Array.from({ length: n }, (_, i) => ({
    deviceId: `${MOCK_DEVICE_PREFIX}${i + 1}`,
    kind: 'videoinput',
    label: `Mock Input ${i + 1}`,
    groupId: `mock-group-${i + 1}`,
  }))
}

/** Colour bar palette, top row of a standard test pattern. */
const BARS = [
  '#c0c0c0', '#c0c000', '#00c0c0', '#00c000',
  '#c000c0', '#c00000', '#0000c0',
]

/**
 * Draw one frame of the test pattern.
 *
 * Exported for the unit tests, which run under jsdom with a stubbed 2D context:
 * they cannot assert pixels, but they can assert that this issues the draw calls
 * it claims to and never touches a null context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{width: number, height: number, label: string, phase: number,
 *          still: boolean}} opts phase is 0..1 through the sweep cycle
 */
export function drawMockFrame(ctx, { width, height, label, phase, still }) {
  if (!ctx) return

  if (still) {
    // A dead input, not a black one: real capture hardware with no source
    // usually shows a very dark grey with visible noise floor rather than true
    // black, and true black would make it impossible to tell a mock still frame
    // from a failure to draw at all.
    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#2a2a30'
    ctx.font = `${Math.round(height * 0.06)}px sans-serif`
    ctx.fillText(`${label} - no source`, width * 0.06, height * 0.5)
    return
  }

  // Colour bars over the top two thirds.
  const barW = width / BARS.length
  const barH = height * 0.66
  for (let i = 0; i < BARS.length; i++) {
    ctx.fillStyle = BARS[i]
    ctx.fillRect(i * barW, 0, barW + 1, barH)
  }

  // Dark base under the bars, so the label has contrast.
  ctx.fillStyle = '#101014'
  ctx.fillRect(0, barH, width, height - barH)

  // The sweep: a vertical bar crossing left to right. This is what makes the
  // stream visibly live, and -- more usefully -- what makes consecutive frames
  // differ, so detection reads the input as carrying signal.
  const sweepW = Math.max(2, width * 0.012)
  const x = phase * (width + sweepW) - sweepW
  ctx.fillStyle = '#ffffff'
  ctx.globalAlpha = 0.55
  ctx.fillRect(x, 0, sweepW, height)
  ctx.globalAlpha = 1

  ctx.fillStyle = '#f0f0f5'
  ctx.font = `${Math.round(height * 0.14)}px sans-serif`
  ctx.fillText(label, width * 0.04, height * 0.88)
}

/**
 * Create a synthetic MediaStream for one mock input.
 *
 * Returns the stream plus a stop() that cancels the draw loop and stops the
 * track. Callers must call stop(): the renderer replaces streams on every input
 * switch, and an abandoned rAF loop drawing into a detached canvas is a leak
 * that would grow for as long as the app runs.
 *
 * @param {{label: string, still?: boolean, width?: number, height?: number,
 *          fps?: number}} opts
 * @returns {{stream: MediaStream, stop: () => void}}
 */
export function createMockStream({
  label,
  still = false,
  width = MOCK_WIDTH,
  height = MOCK_HEIGHT,
  fps = MOCK_FPS,
} = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('mock capture needs a 2D context')
  }
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('mock capture needs canvas.captureStream')
  }

  // Paint once before capturing, so the first frame the consumer sees is the
  // pattern rather than a transparent canvas.
  drawMockFrame(ctx, { width, height, label, phase: 0, still })

  const stream = canvas.captureStream(fps)

  let raf = null
  let stopped = false

  // Sweep period. Slow enough to read as deliberate, fast enough that a
  // detection cycle (~1.6s apart) always samples a different phase.
  const PERIOD_MS = 2400

  // A still input still needs a running loop only if something could clear the
  // canvas; nothing does, so skip the loop entirely and let captureStream
  // repeat the single painted frame. That is also the honest simulation: a dead
  // capture card is not sending 15 identical frames per second because it is
  // working hard.
  if (!still) {
    const start = performance.now()
    const tick = (now) => {
      if (stopped) return
      const phase = ((now - start) % PERIOD_MS) / PERIOD_MS
      drawMockFrame(ctx, { width, height, label, phase, still: false })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  }

  return {
    stream,
    stop() {
      stopped = true
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      stream.getTracks().forEach(track => track.stop())
    },
  }
}
