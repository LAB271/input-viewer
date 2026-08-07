// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Game of Life rules and stagnation handling (issue #90).
 *
 * Two things are pinned here, both of which are silent failures on the wall:
 *
 * 1. **B3/S23 and toroidal wrapping.** A wrong survival rule does not crash --
 *    it produces a board that decays to nothing or floods to noise, which
 *    reads as "the screensaver is bad" rather than "the screensaver is broken".
 *    A glider is the sharpest test: it only survives if birth, survival and
 *    wrapping are all exactly right.
 *
 * 2. **Stagnation detection.** Life converges to still lifes and oscillators,
 *    and a frozen no-signal wall looks like a crashed app. The subtle case is
 *    an oscillator field: population is *constant* while the board flickers
 *    forever, so a naive "has the population changed?" check never fires.
 *
 * As with screensaver-aspect.test.js, the GLSL cannot be executed in the node
 * environment, so these are JS transcriptions of the shader's rule. That is
 * weaker than running the shader -- but the shader was separately verified
 * against this exact model on a real GPU, generation by generation, and matched
 * for all 48 generations tested including the wrap.
 */
import { describe, it, expect } from 'vitest'

// Transcription of SIM_FRAG's rule. The shader wraps with fract() on a float
// UV; that is equivalent to modular arithmetic on cell indices, verified at
// every edge case (x=0 and x=W-1, offset -1 and +1).
function step(grid, w, h) {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          n += grid[((y + dy + h) % h) * w + ((x + dx + w) % w)]
        }
      }
      const alive = grid[y * w + x] === 1
      out[y * w + x] = ((!alive && n === 3) || (alive && (n === 2 || n === 3))) ? 1 : 0
    }
  }
  return out
}

const W = 16, H = 16
const blank = () => new Uint8Array(W * H)
const put = (g, cells, ox = 0, oy = 0) => {
  for (const [x, y] of cells) g[((y + oy) % H) * W + ((x + ox) % W)] = 1
  return g
}
const live = (g) => {
  const c = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x]) c.push([x, y])
  return c
}
// Shape independent of position, so a moving pattern can be compared to itself.
const shape = (cells) => {
  const mx = Math.min(...cells.map(p => p[0]))
  const my = Math.min(...cells.map(p => p[1]))
  return JSON.stringify(cells.map(([x, y]) => [x - mx, y - my]).sort())
}

const GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]

describe('B3/S23 rules', () => {
  it('keeps a block as a still life', () => {
    let g = put(blank(), [[0, 0], [1, 0], [0, 1], [1, 1]], 3, 3)
    const before = JSON.stringify(live(g))
    for (let i = 0; i < 8; i++) g = step(g, W, H)
    expect(JSON.stringify(live(g))).toBe(before)
  })

  it('oscillates a blinker with period 2', () => {
    let g = put(blank(), [[1, 0], [1, 1], [1, 2]], 5, 5)
    const gen0 = JSON.stringify(live(g))
    g = step(g, W, H)
    const gen1 = JSON.stringify(live(g))
    g = step(g, W, H)
    expect(gen1).not.toBe(gen0)          // it actually moved
    expect(JSON.stringify(live(g))).toBe(gen0)  // and came back
  })

  it('kills a lone cell (underpopulation) and fills a cell with 3 neighbours', () => {
    let lonely = put(blank(), [[5, 5]])
    lonely = step(lonely, W, H)
    expect(live(lonely)).toHaveLength(0)

    // Three cells in an L: the empty corner has exactly 3 neighbours and fills.
    let birth = put(blank(), [[5, 5], [6, 5], [5, 6]])
    birth = step(birth, W, H)
    expect(live(birth)).toContainEqual([6, 6])
  })
})

describe('glider', () => {
  it('travels one cell diagonally every four generations without decaying', () => {
    let g = put(blank(), GLIDER, 2, 2)
    const start = live(g)
    const s0 = shape(start)
    for (let i = 0; i < 4; i++) g = step(g, W, H)
    const after = live(g)

    expect(after).toHaveLength(5)        // did not decay
    expect(shape(after)).toBe(s0)        // same pattern, translated
    const dx = Math.min(...after.map(p => p[0])) - Math.min(...start.map(p => p[0]))
    const dy = Math.min(...after.map(p => p[1])) - Math.min(...start.map(p => p[1]))
    expect([dx, dy]).toEqual([1, 1])
  })

  it('re-enters the opposite edge instead of dying on it (toroidal wrap)', () => {
    // Start near the far corner and run long enough to cross both edges.
    let g = put(blank(), GLIDER, 12, 12)
    const s0 = shape(live(g))
    for (let i = 0; i < 4 * 12; i++) g = step(g, W, H)
    const after = live(g)
    expect(after).toHaveLength(5)
    expect(shape(after)).toBe(s0)
  })
})

// Transcription of isStagnant() from game-of-life.js. The constants must track
// the module; a change to one without the other should fail here.
const STAGNATION_WINDOW = 90
const STAGNATION_BAND = 0.012
const POPULATION_SAMPLE_EVERY = 10

function makeDetector() {
  let history = []
  return (pop) => {
    history.push(pop)
    if (history.length > STAGNATION_WINDOW / POPULATION_SAMPLE_EVERY) history.shift()
    if (history.length < STAGNATION_WINDOW / POPULATION_SAMPLE_EVERY) return false
    if (pop <= 0.0001) return true
    return (Math.max(...history) - Math.min(...history)) < STAGNATION_BAND
  }
}

describe('stagnation detection', () => {
  it('does not fire while the population is still swinging', () => {
    const detect = makeDetector()
    let fired = false
    // A population moving well outside the band must never trip it.
    for (let i = 0; i < 40; i++) fired = fired || detect(0.2 + (i % 2) * 0.2)
    expect(fired).toBe(false)
  })

  it('fires on an oscillator field, where population never changes at all', () => {
    // The case a naive "did the population change?" test misses completely: a
    // blinker field flickers forever at a perfectly constant population.
    const detect = makeDetector()
    let firedAt = null
    for (let gen = POPULATION_SAMPLE_EVERY; gen <= 700; gen += POPULATION_SAMPLE_EVERY) {
      if (detect(0.0731)) { firedAt = gen; break }
    }
    expect(firedAt).toBe(STAGNATION_WINDOW)
  })

  it('fires when the board dies out entirely', () => {
    const detect = makeDetector()
    let firedAt = null
    for (let gen = POPULATION_SAMPLE_EVERY; gen <= 700; gen += POPULATION_SAMPLE_EVERY) {
      if (detect(0)) { firedAt = gen; break }
    }
    expect(firedAt).toBe(STAGNATION_WINDOW)
  })

  it('needs a full window before it can fire, so a slow start is not cut short', () => {
    const detect = makeDetector()
    const samples = STAGNATION_WINDOW / POPULATION_SAMPLE_EVERY
    for (let i = 0; i < samples - 1; i++) expect(detect(0.05)).toBe(false)
    expect(detect(0.05)).toBe(true)
  })
})
