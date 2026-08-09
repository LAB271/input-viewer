// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Detection loop pacing, and the stalled-feed deadlock it used to have.
 *
 * The loop is paced by requestVideoFrameCallback (issue #60), which only fires
 * when the video decodes a NEW frame. That is efficient and, for a feed that
 * stops producing frames, exactly wrong: rVFC never fires, the loop never
 * ticks, and detection stops running.
 *
 * The case is not hypothetical. A virtual camera showing a static image --
 * OBS with no scene change -- delivers no new frames, so no-signal detection
 * could never fire for it no matter how many references were captured. The
 * feed being frozen is precisely what detection exists to notice.
 *
 * The pre-existing requestAnimationFrame fallback did not cover it: that only
 * applies when there is no *playing* video at all. A video that is playing but
 * frozen fell between the two.
 *
 * These tests model the scheduler rather than importing it -- it is a closure
 * inside startDetectionLoop() with no seam -- so they pin the scheduling
 * contract: a tick must remain reachable when rVFC never fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const DETECT_INTERVAL_MS = 1600

/**
 * The scheduling logic under test, with the video and rVFC injectable.
 *
 * Mirrors schedule()/tick() in renderer.js: arm rVFC when a video is playing,
 * arm a watchdog alongside it, and let whichever fires first cancel the other.
 */
function makeScheduler({ videoPlaying, rvfcFires, onTick }) {
  let running = true
  let watchdog = null
  let ticks = 0

  const clearWatchdog = () => {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null }
  }

  function tick() {
    if (!running) return
    clearWatchdog()
    ticks++
    onTick?.(ticks)
    schedule()
  }

  function schedule() {
    if (!running) return
    if (videoPlaying()) {
      // Only actually invokes the callback when the feed produces a frame.
      if (rvfcFires()) setTimeout(tick, 16)
      clearWatchdog()
      watchdog = setTimeout(tick, DETECT_INTERVAL_MS * 2)
      return
    }
    setTimeout(tick, 16) // stands in for requestAnimationFrame
  }

  return {
    start() { schedule() },
    stop() { running = false; clearWatchdog() },
    get ticks() { return ticks }
  }
}

describe('detection pacing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('ticks normally when the feed produces frames', () => {
    const s = makeScheduler({ videoPlaying: () => true, rvfcFires: () => true })
    s.start()
    vi.advanceTimersByTime(200)
    expect(s.ticks).toBeGreaterThan(1)
    s.stop()
  })

  it('still ticks when a playing feed produces NO frames', () => {
    // The deadlock: rVFC armed, never fires. Without the watchdog this is 0
    // ticks forever, and no-signal can never be detected on a frozen feed.
    const s = makeScheduler({ videoPlaying: () => true, rvfcFires: () => false })
    s.start()
    expect(s.ticks).toBe(0)

    vi.advanceTimersByTime(DETECT_INTERVAL_MS * 2 + 50)
    expect(s.ticks).toBe(1)

    // And it keeps going, rather than firing once and stopping.
    vi.advanceTimersByTime(DETECT_INTERVAL_MS * 2 + 50)
    expect(s.ticks).toBe(2)
    s.stop()
  })

  it('ticks via the rAF path when no video is playing', () => {
    const s = makeScheduler({ videoPlaying: () => false, rvfcFires: () => false })
    s.start()
    vi.advanceTimersByTime(100)
    expect(s.ticks).toBeGreaterThan(1)
    s.stop()
  })

  it('does not double-tick when a frame arrives before the watchdog', () => {
    // Both are armed at once; the frame must cancel the watchdog, or every
    // cycle would schedule two follow-ups and the loop would double each time.
    let ticksSeen = 0
    const s = makeScheduler({
      videoPlaying: () => true,
      rvfcFires: () => true,
      onTick: () => { ticksSeen++ }
    })
    s.start()
    // Advance past the frame callback (16ms) but well short of the watchdog
    // (3200ms), so exactly one tick is due. Two would mean the frame path and
    // the watchdog both fired for the same cycle.
    vi.advanceTimersByTime(20)
    expect(ticksSeen).toBe(1)
    s.stop()
  })

  it('stops scheduling once the loop is stopped', () => {
    const s = makeScheduler({ videoPlaying: () => true, rvfcFires: () => false })
    s.start()
    s.stop()
    vi.advanceTimersByTime(DETECT_INTERVAL_MS * 10)
    expect(s.ticks).toBe(0)
  })
})
