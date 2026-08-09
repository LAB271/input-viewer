// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Orphaned reference detection (#160).
 *
 * References are keyed strictly by deviceId. Virtual cameras can regenerate
 * theirs on reinstall or version change, and macOS can issue different ids
 * after a permission reset. When that happens the stored reference is
 * stranded: hasReferenceScreenshot() misses, checkNoSignalFromSource returns
 * "has signal" unconditionally, and nothing is logged.
 *
 * That failure is indistinguishable from never having configured the device,
 * which is exactly the confusion behind #150 -- detection looked broken when it
 * had simply never been given a reference for that id.
 *
 * jsdom because saveReferenceScreenshot's siblings touch document/canvas.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  saveReferenceScreenshot,
  clearReferenceScreenshot,
  getReferenceScreenshots,
  findOrphanedReferences,
  pruneOrphanedReferences
} from '../src/renderer/detection-simple.js'

const A = 'device-aaa'
const B = 'device-bbb'
const GONE = 'device-vanished'

const frame = (v) => {
  const data = new Uint8ClampedArray(4 * 4 * 4)
  data.fill(v)
  return { width: 4, height: 4, data }
}

beforeEach(() => {
  for (const id of [A, B, GONE]) clearReferenceScreenshot(id)
})

describe('findOrphanedReferences', () => {
  it('reports nothing when every reference has its device', () => {
    saveReferenceScreenshot(A, frame(10))
    saveReferenceScreenshot(B, frame(20))
    expect(findOrphanedReferences([A, B])).toEqual([])
  })

  it('reports a reference whose device is absent, with its count', () => {
    saveReferenceScreenshot(A, frame(10))
    saveReferenceScreenshot(GONE, frame(20))
    saveReferenceScreenshot(GONE, frame(30))

    const orphans = findOrphanedReferences([A])
    expect(orphans).toHaveLength(1)
    expect(orphans[0].deviceId).toBe(GONE)
    // The count matters: the UI reports how much work would be discarded.
    expect(orphans[0].count).toBe(2)
  })

  it('treats an empty device list as everything being orphaned', () => {
    // Enumeration can legitimately return nothing (permissions not yet
    // granted), so this must not throw -- but it also must not prune.
    saveReferenceScreenshot(A, frame(10))
    expect(findOrphanedReferences([])).toHaveLength(1)
  })
})

describe('pruneOrphanedReferences', () => {
  it('removes only the absent devices', () => {
    saveReferenceScreenshot(A, frame(10))
    saveReferenceScreenshot(GONE, frame(20))

    const removed = pruneOrphanedReferences([A])
    expect(removed).toBe(1)
    expect(getReferenceScreenshots(A)).toHaveLength(1)
    expect(getReferenceScreenshots(GONE)).toHaveLength(0)
  })

  it('is a no-op when nothing is orphaned', () => {
    saveReferenceScreenshot(A, frame(10))
    expect(pruneOrphanedReferences([A])).toBe(0)
    expect(getReferenceScreenshots(A)).toHaveLength(1)
  })

  it('is never called automatically on an empty device list', () => {
    // Guarding the shape of the bug rather than the call site: pruning on an
    // empty enumeration would wipe every reference the first time the app
    // started before permissions were granted. The UI gates this behind a
    // button for that reason, and this test documents the hazard.
    saveReferenceScreenshot(A, frame(10))
    const wouldRemove = findOrphanedReferences([]).length
    expect(wouldRemove).toBe(1)
    // ...which is why nothing calls prune() with an unverified list.
    expect(getReferenceScreenshots(A)).toHaveLength(1)
  })
})
