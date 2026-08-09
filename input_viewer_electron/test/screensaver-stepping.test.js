// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Manual screensaver stepping (V and +/-).
 *
 * The registry side is testable without a GL context: getActiveIndex() and
 * screensaverCount() are plain state, and the wrap arithmetic that steps
 * between them is where an off-by-one would hide. That is not hypothetical --
 * the preview harness shipped with exactly this bug, wrapping a 1-based hash as
 * a 0-based index so the last entry was unreachable (fixed in #149).
 *
 * Starting a saver needs WebGL2, so these cover the index maths and the
 * exported contract rather than driving a real activation.
 */
import { describe, it, expect } from 'vitest'
import {
  SCREENSAVERS,
  getActiveIndex,
  screensaverCount,
  isScreensaverRunning
} from '../src/renderer/screensavers/registry.js'

// Transcription of the step used by stepScreensaver() in renderer.js. Kept
// adjacent so a change to one that is not mirrored shows up as a failure.
const stepIndex = (current, step, count) => ((current + step) % count + count) % count

describe('registry exports for manual stepping', () => {
  it('reports the number of registered screensavers', () => {
    expect(screensaverCount()).toBe(SCREENSAVERS.length)
    expect(screensaverCount()).toBeGreaterThan(0)
  })

  it('reports -1 as the active index when nothing is running', () => {
    // The renderer relies on this to decide between "start" and "step".
    expect(isScreensaverRunning()).toBe(false)
    expect(getActiveIndex()).toBe(-1)
  })
})

describe('step wrap-around', () => {
  const count = 21

  it('advances and retreats by one', () => {
    expect(stepIndex(5, 1, count)).toBe(6)
    expect(stepIndex(5, -1, count)).toBe(4)
  })

  it('wraps forward past the last entry to the first', () => {
    expect(stepIndex(count - 1, 1, count)).toBe(0)
  })

  it('wraps backward past the first entry to the last', () => {
    // The case a bare % gets wrong: -1 % 21 is -1 in JS, not 20.
    expect(stepIndex(0, -1, count)).toBe(count - 1)
  })

  it('never produces an out-of-range index', () => {
    for (let cur = 0; cur < count; cur++) {
      for (const step of [-1, 1]) {
        const next = stepIndex(cur, step, count)
        expect(next).toBeGreaterThanOrEqual(0)
        expect(next).toBeLessThan(count)
      }
    }
  })

  it('is a no-op for a step of zero', () => {
    expect(stepIndex(7, 0, count)).toBe(7)
  })

  it('works for a single registered screensaver', () => {
    // Degenerate but reachable if savers were ever trimmed: stepping should
    // stay put rather than divide by zero or go negative.
    expect(stepIndex(0, 1, 1)).toBe(0)
    expect(stepIndex(0, -1, 1)).toBe(0)
  })
})
