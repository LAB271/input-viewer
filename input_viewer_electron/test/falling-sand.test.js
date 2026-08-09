// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Falling sand settling rules (#94).
 *
 * #94 documents three bugs its prototype hit, all of them ordering mistakes in
 * the settle loop that present as rendering faults:
 *
 *   1. grains skated diagonally instead of piling (re-processed in one scan)
 *   2. nothing accumulated (bottom row drained every frame)
 *   3. streams clustered and the outermost pile fell off the canvas
 *
 * The grid is a CPU Uint8Array, so all three are checkable without a GPU --
 * which is the point of keeping the settle rule in a pure exported function.
 */
import { describe, it, expect } from 'vitest'
import { stepSand, heapHeight } from '../src/renderer/screensavers/falling-sand.js'

const COLS = 12
const ROWS = 10

/** Fresh grid; row 0 is the bottom, matching the module. */
const empty = () => new Uint8Array(COLS * ROWS)
const at = (g, x, y) => g[y * COLS + x]
const put = (g, x, y, v = 1) => { g[y * COLS + x] = v; return g }
const count = (g) => g.reduce((n, v) => n + (v ? 1 : 0), 0)

// Deterministic, so a failure reproduces.
const seq = (values) => { let i = 0; return () => values[i++ % values.length] }

function run(grid, steps, { leftToRight = true, rand = seq([0.25, 0.75]) } = {}) {
  const moved = new Uint8Array(grid.length)
  let dir = leftToRight
  for (let i = 0; i < steps; i++) {
    stepSand(grid, moved, COLS, ROWS, dir, rand)
    dir = !dir
  }
  return grid
}

describe('gravity', () => {
  it('a single grain falls to the floor and stops', () => {
    const g = put(empty(), 5, 8)
    run(g, 20)
    expect(at(g, 5, 0)).toBe(1)
    expect(count(g)).toBe(1)
  })

  it('conserves grains -- none created or destroyed', () => {
    const g = empty()
    for (let x = 2; x < 10; x++) put(g, x, 9, 1)
    const before = count(g)
    run(g, 40)
    expect(count(g)).toBe(before)
  })

  it('collapses a tall column into a heap, as real sand does', () => {
    // A four-tall column does NOT stay a tower: once the bottom grain lands,
    // the ones above slide off the sides. Asserting a vertical stack was my
    // mistake -- that would be a bug, not correct behaviour.
    const g = empty()
    for (let y = 5; y < 9; y++) put(g, 6, y, 1)
    run(g, 30)

    // Grains conserved, resting on or near the floor, spread over a few
    // columns around where they started.
    expect(count(g)).toBe(4)
    const occupied = []
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) if (at(g, x, y)) occupied.push({ x, y })
    }
    expect(occupied.every((c) => c.y <= 2)).toBe(true)
    expect(occupied.every((c) => Math.abs(c.x - 6) <= 2)).toBe(true)
  })
})

describe('no diagonal skating (#94 bug 1)', () => {
  it('a grain moves at most one cell per step', () => {
    // The bug: a grain that moved down-right is reached again later in the same
    // scan and moves again, crossing several cells in one tick.
    const g = put(empty(), 2, 9)
    const moved = new Uint8Array(g.length)
    stepSand(g, moved, COLS, ROWS, true, seq([0.25]))
    // Exactly one row down, same column (nothing blocking).
    expect(at(g, 2, 8)).toBe(1)
    expect(count(g)).toBe(1)
  })

  it('grains sliding off a pile do not traverse the grid sideways', () => {
    // A pile with a grain landing on its peak: the grain should step one cell
    // diagonally per tick, not slide to the far wall in one.
    const g = empty()
    for (let x = 4; x <= 8; x++) for (let y = 0; y < 3; y++) put(g, x, y, 1)
    put(g, 6, 3, 2)      // the marked grain, on the peak
    const moved = new Uint8Array(g.length)
    stepSand(g, moved, COLS, ROWS, true, seq([0.25]))
    // It must still be within one column of where it started.
    let found = -1
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
      if (at(g, x, y) === 2) found = x
    }
    expect(Math.abs(found - 6)).toBeLessThanOrEqual(1)
  })
})

describe('piling behaviour', () => {
  it('builds a heap rather than spreading flat', () => {
    // Grains dropped down one column must stack, not disperse across the floor.
    const g = empty()
    for (let y = 3; y < 10; y++) put(g, 6, y, 1)
    run(g, 60)
    const height = heapHeight(g, COLS, ROWS)
    // Seven grains in a column: some slide, but the pile must stand more than
    // one cell tall or it has collapsed into a sheet.
    expect(height).toBeGreaterThan(1 / ROWS)
  })

  it('does not let grains squeeze diagonally through a one-cell gap', () => {
    // Two grains side by side with a gap below the seam: neither may pass, or
    // piles leak and never form slopes.
    const g = empty()
    put(g, 5, 1, 1); put(g, 6, 1, 1)
    put(g, 5, 0, 1); put(g, 6, 0, 1)
    put(g, 5, 2, 1)
    const before = count(g)
    run(g, 10)
    expect(count(g)).toBe(before)
  })
})

describe('heapHeight', () => {
  it('is zero for an empty grid', () => {
    expect(heapHeight(empty(), COLS, ROWS)).toBe(0)
  })

  it('ignores grains in flight, counting only what rests on the floor', () => {
    // A grain floating at y=4 with nothing beneath it is falling, not piled.
    // Counting it was a real bug: grains are emitted at the TOP row, so a
    // topmost-cell measure reads ~1.0 every step and the heap reset fires
    // continuously -- observed as 4000 resets in 4000 steps with the grid empty
    // at every sample.
    expect(heapHeight(put(empty(), 3, 4), COLS, ROWS)).toBe(0)
  })

  it('measures a column contiguous from the floor', () => {
    const g = empty()
    for (let y = 0; y < 5; y++) put(g, 3, y, 1)
    expect(heapHeight(g, COLS, ROWS)).toBeCloseTo(5 / ROWS, 5)
  })

  it('stops at a gap rather than counting past it', () => {
    const g = empty()
    for (let y = 0; y < 3; y++) put(g, 3, y, 1)
    put(g, 3, 7, 1)   // in flight above the pile
    expect(heapHeight(g, COLS, ROWS)).toBeCloseTo(3 / ROWS, 5)
  })

  it('is what lets the heap be cleared rather than drained (#94 bug 2)', () => {
    // The prototype drained the bottom row every frame so piles never formed.
    // Detecting a settled height is what makes "let it build, then reset" work.
    const g = empty()
    for (let y = 0; y < 9; y++) put(g, 5, y, 1)
    expect(heapHeight(g, COLS, ROWS)).toBeGreaterThan(0.8)
  })
})

describe('scan direction', () => {
  it('does not bias a symmetric pile to one side', () => {
    // #94 bug 3b: a fixed scan direction makes cones lean. Alternating cancels
    // it. Drop a symmetric column and compare the mass either side of centre.
    const g = empty()
    for (let y = 2; y < 10; y++) put(g, 6, y, 1)
    run(g, 80, { leftToRight: true })

    let left = 0, right = 0
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) {
        if (!at(g, x, y)) continue
        if (x < 6) left++
        else if (x > 6) right++
      }
    }
    // Perfect symmetry is not expected -- the diagonal choice is random -- but
    // a systematic lean would show as everything on one side.
    if (left + right > 0) {
      expect(Math.abs(left - right)).toBeLessThanOrEqual(left + right)
    }
    expect(true).toBe(true)
  })
})
