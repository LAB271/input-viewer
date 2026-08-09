// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tree growth geometry (#95).
 *
 * Growth is driven by a progress value over a depth-ordered segment list, so
 * the first N segments ARE the tree at progress N/total. That property is what
 * makes the animation stateless and the reset trivial, and it is the main thing
 * worth pinning -- if the list stopped being depth-ordered, trees would grow
 * their canopy before their trunk.
 *
 * Two bugs were caught here by measuring rather than looking, both of which
 * would have been obvious on screen but only after building the whole GL path:
 *
 *   - trees grew DOWNWARD off the canvas (sin of a negative angle in y-up
 *     pixel space; measured y range -710..-200)
 *   - segment count reached 4,100 per tree, ~40,000 across a 14-tree wall
 */
import { describe, it, expect } from 'vitest'
import { buildTree } from '../src/renderer/screensavers/tree-growth.js'
import { createRng } from '../src/renderer/screensavers/seed.js'

const UP = Math.PI / 2

describe('buildTree geometry', () => {
  it('grows upward in y-up pixel space', () => {
    // The bug: -PI/2 grows downward off the bottom of the canvas.
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    const ys = segs.map((s) => s.y1)
    expect(Math.min(...ys)).toBeGreaterThan(0)
  })

  it('starts at the given root', () => {
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    expect(segs[0].x0).toBe(500)
    expect(segs[0].y0).toBe(0)
  })

  it('tapers from trunk to tip', () => {
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    const trunk = segs[0]
    const deepest = segs[segs.length - 1]
    expect(trunk.w0).toBeGreaterThan(deepest.w1 * 5)
  })

  it('stays within a plausible bounding region', () => {
    // A tree with a 200px trunk should not sprawl 10x that; a broken angle or
    // length ratio shows up here rather than as a visual oddity later.
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    const xs = segs.map((s) => s.x1)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(200 * 6)
  })
})

describe('depth ordering', () => {
  it('is non-decreasing, so growth reveals trunk before canopy', () => {
    // The property the whole progress-driven design rests on.
    const segs = buildTree(500, 0, 200, 12, UP, createRng(7))
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].depth).toBeGreaterThanOrEqual(segs[i - 1].depth)
    }
  })

  it('puts exactly one segment at depth 0', () => {
    const segs = buildTree(500, 0, 200, 12, UP, createRng(3))
    expect(segs.filter((s) => s.depth === 0)).toHaveLength(1)
  })

  it('reveals a connected tree at any progress point', () => {
    // Taking the first N segments must never leave a branch whose parent is not
            // yet drawn -- that would render as a floating twig.
    const segs = buildTree(500, 0, 200, 12, UP, createRng(11))
    for (const fraction of [0.1, 0.4, 0.8]) {
      const n = Math.floor(segs.length * fraction)
      const shown = segs.slice(0, n)
      const maxDepth = shown.reduce((m, s) => Math.max(m, s.depth), 0)
      // Every depth below the deepest shown must be fully present, which
      // follows from depth ordering and is what guarantees connectivity.
      for (let d = 0; d < maxDepth; d++) {
        const atDepth = segs.filter((s) => s.depth === d).length
        const shownAtDepth = shown.filter((s) => s.depth === d).length
        expect(shownAtDepth).toBe(atDepth)
      }
    }
  })
})

describe('cost', () => {
  it('stays affordable across a wall-sized row', () => {
    // #95 warns branch count is exponential and a 6000px wall fits ~14 trees.
    // At depth 9 with an occasional third child this measured 4,100 per tree.
    let total = 0
    for (let t = 0; t < 14; t++) {
      total += buildTree(500, 0, 200, 12, UP, createRng(t + 1)).length
    }
    expect(total).toBeLessThan(20000)
  })

  it('varies between trees, so a row is not cloned', () => {
    const a = buildTree(500, 0, 200, 12, UP, createRng(1)).length
    const b = buildTree(500, 0, 200, 12, UP, createRng(2)).length
    expect(a).not.toBe(b)
  })
})

describe('foliage', () => {
  it('marks the outer levels and leaves the inner ones as wood', () => {
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    expect(segs.some((s) => s.foliage === 0)).toBe(true)
    expect(segs.some((s) => s.foliage > 0)).toBe(true)
    // The trunk is never foliage -- that colour switch is what makes it read as
    // a tree rather than a fractal.
    expect(segs[0].foliage).toBe(0)
  })

  it('is dominated by wood when measured by area rather than count', () => {
    // 80% of SEGMENTS are foliage, which looked wrong until measured properly:
    // outer twigs are short and thin, so length x width puts wood well ahead.
    const segs = buildTree(500, 0, 200, 12, UP, createRng(1))
    let wood = 0, leaf = 0
    for (const s of segs) {
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
      const area = len * (s.w0 + s.w1) * 0.5
      if (s.foliage > 0) leaf += area
      else wood += area
    }
    expect(wood).toBeGreaterThan(leaf)
  })
})
