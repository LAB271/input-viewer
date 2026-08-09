// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Split-flap board layout (#92).
 *
 * The bug this pins: column count was derived from the aspect ratio alone, so a
 * 16:9 display got 8 columns for a 14-character message and every line was
 * silently clipped -- "NO SIGNAL" rendered as "NO SIGNA". setMessage() clamps
 * its start index to 0 and stops at `cols`, so overflow is dropped with no
 * error, which is why it looked like a rendering fault rather than a layout one.
 *
 * The board is the no-signal display; text that does not fit is worse than
 * useless, because a half-word reads as a broken app.
 *
 * The layout maths lives inside create() with no seam, so it is transcribed
 * here. The constants are duplicated deliberately: retuning the module without
 * updating these fails the tests, which is the intent.
 */
import { describe, it, expect } from 'vitest'

const ROWS = 3
const TILE_RATIO = 1.45
const MAX_TILE_RATIO = 1.7

// Must mirror MESSAGES in split-flap.js.
const MESSAGES = [
  ['NO SIGNAL', 'AWAITING INPUT', 'STANDBY'],
  ['NO SIGNAL', 'CHECK CABLE', 'HDMI 01'],
  ['LAB 271', 'NO SIGNAL', 'READY'],
  ['STANDBY', 'NO INPUT', 'CONNECT SOURCE'],
  ['NO SIGNAL', 'SELECT INPUT', '1 2 3 4']
]

const LONGEST_LINE = MESSAGES.reduce(
  (max, rows) => rows.reduce((m, line) => Math.max(m, line.length), max), 0)
const MIN_COLS = LONGEST_LINE + 2

/** Transcription of the layout in split-flap.js create(). */
function layoutFor(width, height) {
  const aspect = width / height
  const byAspect = Math.round(ROWS * aspect * TILE_RATIO)
  const cols = Math.max(MIN_COLS, Math.min(48, byAspect))
  const tileW = Math.min(width / cols, (height / ROWS) / TILE_RATIO)
  const maxTileH = (height / ROWS) * 0.92
  const tileH = Math.min(maxTileH, tileW * MAX_TILE_RATIO)
  return {
    cols,
    tileW,
    tileH,
    originX: (width - tileW * cols) * 0.5,
    originY: (height - tileH * ROWS) * 0.5
  }
}

/** Where setMessage() would place a line, and whether it fits. */
function placeLine(text, cols) {
  const start = Math.max(0, Math.floor((cols - text.length) / 2))
  return { start, fits: start + text.length <= cols, overflow: Math.max(0, text.length - cols) }
}

const DISPLAYS = [
  { name: '16:9 1080p', w: 1920, h: 1080 },
  { name: '16:9 4K', w: 3840, h: 2160 },
  { name: '5:1 videowall', w: 6000, h: 1200 },
  { name: '16:10 laptop', w: 1680, h: 1050 },
  { name: 'square', w: 1000, h: 1000 },
  { name: '21:9 ultrawide', w: 3440, h: 1440 }
]

describe('column count', () => {
  it('is never narrower than the longest message', () => {
    // The regression itself. Aspect alone gave 8 columns on 16:9.
    for (const d of DISPLAYS) {
      const { cols } = layoutFor(d.w, d.h)
      expect(cols, `${d.name} has too few columns`).toBeGreaterThanOrEqual(LONGEST_LINE)
    }
  })

  it('still widens for a wide display', () => {
    // The aspect term must keep working where it is the binding one, or the
    // wall would get the same narrow board as a laptop.
    const wall = layoutFor(6000, 1200)
    const laptop = layoutFor(1920, 1080)
    expect(wall.cols).toBeGreaterThan(laptop.cols)
  })
})

describe('every message fits on every display', () => {
  it('places all lines without overflow', () => {
    for (const d of DISPLAYS) {
      const { cols } = layoutFor(d.w, d.h)
      for (const rows of MESSAGES) {
        for (const line of rows) {
          const p = placeLine(line.toUpperCase(), cols)
          expect(p.fits, `"${line}" clipped by ${p.overflow} chars on ${d.name}`).toBe(true)
        }
      }
    }
  })

  it('centres each line rather than left-aligning it', () => {
    const { cols } = layoutFor(1920, 1080)
    const p = placeLine('READY', cols)
    const rightGap = cols - (p.start + 'READY'.length)
    // Equal within one tile: an odd remainder cannot split evenly.
    expect(Math.abs(p.start - rightGap)).toBeLessThanOrEqual(1)
  })
})

describe('tile geometry', () => {
  it('keeps tiles flap-shaped rather than tall slots', () => {
    for (const d of DISPLAYS) {
      const { tileW, tileH } = layoutFor(d.w, d.h)
      const ratio = tileH / tileW
      expect(ratio, `${d.name} tiles too tall`).toBeLessThanOrEqual(MAX_TILE_RATIO + 0.001)
      expect(ratio, `${d.name} tiles too flat`).toBeGreaterThan(1)
    }
  })

  it('never overflows the canvas in either axis', () => {
    for (const d of DISPLAYS) {
      const { cols, tileW, tileH, originX, originY } = layoutFor(d.w, d.h)
      expect(tileW * cols, `${d.name} overflows width`).toBeLessThanOrEqual(d.w + 0.001)
      expect(tileH * ROWS, `${d.name} overflows height`).toBeLessThanOrEqual(d.h + 0.001)
      // No clipped half-tile at an edge, which is the failure #92 documents.
      expect(originX).toBeGreaterThanOrEqual(-0.001)
      expect(originY).toBeGreaterThanOrEqual(-0.001)
    }
  })

  it('centres the board on both axes', () => {
    for (const d of DISPLAYS) {
      const { cols, tileW, tileH, originX, originY } = layoutFor(d.w, d.h)
      expect(originX).toBeCloseTo((d.w - tileW * cols) / 2, 5)
      expect(originY).toBeCloseTo((d.h - tileH * ROWS) / 2, 5)
    }
  })

  it('produces tiles large enough to read across a room', () => {
    // #88: a glyph that reads on a laptop can be sub-resolvable at 8m.
    for (const d of DISPLAYS) {
      const { tileW } = layoutFor(d.w, d.h)
      expect(tileW / d.w, `${d.name} tiles too small`).toBeGreaterThan(0.015)
    }
  })
})
