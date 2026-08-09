// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Frost / DLA dendrite growth (#100).
 *
 * #100's central warning is that screenshots are misleading here: a dense mass
 * and a fern both read as "white-ish" at a glance. Its perimeter/area metric is
 * the reliable discriminator, and it recommends porting it into a test --
 * which is what this file does.
 *
 *   perim/ice ~1.0  every cell on the boundary  -> dendritic
 *   perim/ice ~0.5  half the cells interior     -> solid mass
 *
 * The metric is also what caught a bug NOT in the issue: a walker stepping both
 * axes at once reaches interior gaps too easily, so the ratio degrades as the
 * cluster grows (0.87 at 1% coverage to 0.77 at 6%) while a 4-neighbour walk
 * holds flat. The diagonal version still looks like branching ice, so only the
 * measurement distinguishes them.
 */
import { describe, it, expect } from 'vitest'
import { perimeterRatio, releaseWalker } from '../src/renderer/screensavers/frost.js'

/** Deterministic RNG so a failure reproduces. */
function makeRand(seed = 42) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

/** Grow a cluster with the shipped walker, to a coverage fraction. */
function grow(cols, rows, coverage, seed = 42) {
  const ice = new Uint8Array(cols * rows)
  const depthTop = new Int16Array(cols).fill(-1)
  const depthBottom = new Int16Array(cols).fill(-1)
  const rand = makeRand(seed)

  for (let n = 0; n < Math.max(10, Math.round((cols + rows) / 30)); n++) {
    const x = Math.floor(rand() * cols)
    ice[rand() < 0.5 ? x : (rows - 1) * cols + x] = 1
  }

  const band = Math.max(8, Math.round(Math.min(cols, rows) * 0.5))
  const minFlight = Math.max(4, Math.round(band * 0.4))
  const target = Math.round(cols * rows * coverage)
  let count = 0
  for (const c of ice) count += c

  let guard = 0
  while (count < target && guard++ < target * 3000) {
    const at = releaseWalker(ice, cols, rows, depthTop, depthBottom, band, minFlight, rand)
    if (at < 0) continue
    ice[at] = 1
    count++
    const x = at % cols
    const y = Math.floor(at / cols)
    if (y < rows / 2) { if (y > depthTop[x]) depthTop[x] = y }
    else if (rows - 1 - y > depthBottom[x]) depthBottom[x] = rows - 1 - y
  }
  return { ice, count }
}

describe('perimeterRatio', () => {
  it('is 0 for an empty grid', () => {
    expect(perimeterRatio(new Uint8Array(100), 10, 10).ratio).toBe(0)
  })

  it('is 1 for a single cell -- entirely boundary', () => {
    const ice = new Uint8Array(100)
    ice[55] = 1
    expect(perimeterRatio(ice, 10, 10).ratio).toBe(1)
  })

  it('is 1 for a one-cell-wide line -- the dendritic ideal', () => {
    const ice = new Uint8Array(100)
    for (let x = 2; x < 8; x++) ice[5 * 10 + x] = 1
    expect(perimeterRatio(ice, 10, 10).ratio).toBe(1)
  })

  it('drops well below 1 for a solid block -- the failure mode', () => {
    // A 6x6 block: the inner 4x4 have no empty neighbour, so 16 of 36 are
    // interior. This is what "dense mass" looks like numerically.
    const ice = new Uint8Array(100)
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) ice[y * 10 + x] = 1
    const m = perimeterRatio(ice, 10, 10)
    expect(m.ice).toBe(36)
    expect(m.ratio).toBeLessThan(0.7)
  })
})

describe('grown clusters are dendritic, not dense', () => {
  it('holds a high perimeter ratio on a wide grid', () => {
    // The wall's aspect. #100 measured 0.99 at 1.3% and 0.98 at 2.9%.
    for (const coverage of [0.01, 0.03, 0.06]) {
      const { ice } = grow(240, 60, coverage)
      const m = perimeterRatio(ice, 240, 60)
      expect(m.ratio, `wide grid at ${coverage * 100}% coverage`).toBeGreaterThan(0.85)
    }
  })

  it('holds a high perimeter ratio on a squarer grid', () => {
    for (const coverage of [0.01, 0.05]) {
      const { ice } = grow(150, 100, coverage)
      const m = perimeterRatio(ice, 150, 100)
      expect(m.ratio, `square grid at ${coverage * 100}% coverage`).toBeGreaterThan(0.85)
    }
  })

  it('does not degrade sharply as coverage grows', () => {
    // The diagonal-walk bug's signature: a ratio that falls away with coverage.
    const low = perimeterRatio(...(() => {
      const g = grow(240, 60, 0.01)
      return [g.ice, 240, 60]
    })()).ratio
    const high = perimeterRatio(...(() => {
      const g = grow(240, 60, 0.06)
      return [g.ice, 240, 60]
    })()).ratio
    expect(high).toBeGreaterThan(low - 0.12)
  })
})

describe('releaseWalker', () => {
  it('returns -1 rather than sticking when there is no ice', () => {
    const cols = 40, rows = 40
    const ice = new Uint8Array(cols * rows)
    const at = releaseWalker(ice, cols, rows,
      new Int16Array(cols).fill(-1), new Int16Array(cols).fill(-1),
      12, 5, makeRand(7))
    expect(at).toBe(-1)
  })

  it('sticks adjacent to existing ice, never on top of it', () => {
    const cols = 40, rows = 40
    const ice = new Uint8Array(cols * rows)
    // A bar across the bottom.
    for (let x = 0; x < cols; x++) ice[x] = 1
    const rand = makeRand(11)
    let stuck = 0
    for (let i = 0; i < 200; i++) {
      const at = releaseWalker(ice, cols, rows,
        new Int16Array(cols).fill(-1), new Int16Array(cols).fill(-1),
        12, 5, rand)
      if (at < 0) continue
      expect(ice[at], 'walker stuck on an occupied cell').toBe(0)
      ice[at] = 1
      stuck++
    }
    expect(stuck).toBeGreaterThan(0)
  })

  it('respects the minimum free flight, so it cannot weld on contact', () => {
    // #100 bug 3: without a minimum flight, walkers spawned beside ice stick at
    // the outermost row and the release band becomes a solid white bar.
    const cols = 60, rows = 60
    const ice = new Uint8Array(cols * rows)
    for (let x = 0; x < cols; x++) ice[x] = 1
    const rand = makeRand(3)
    // With a large minimum flight, a walker cannot stick on its first steps.
    let immediate = 0
    for (let i = 0; i < 300; i++) {
      const at = releaseWalker(ice, cols, rows,
        new Int16Array(cols).fill(-1), new Int16Array(cols).fill(-1),
        20, 20, rand)
      if (at >= 0 && Math.floor(at / cols) === 1) immediate++
    }
    // Some growth on row 1 is legitimate; a solid bar would be every walker.
    expect(immediate).toBeLessThan(200)
  })
})
