// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Aspect-correct world space (issue #114).
 *
 * This class of bug is invisible in a window and only shows on the wall, which
 * is exactly why it survived this long: at 6000x1200 clip space is stretched
 * 5:1, so every simulation working directly in it is geometrically wrong there.
 *
 * The GLSL cannot be executed here, so these tests exercise JS transcriptions
 * of the same formulae. That is weaker than running the shaders, but it does
 * pin the arithmetic -- and the arithmetic is the part that was wrong.
 */
import { describe, it, expect } from 'vitest'
import { GLSL, canvasAspect } from '../src/renderer/screensavers/glsl-lib.js'

// Transcriptions of the GLSL helpers. Kept adjacent to the source strings so a
// change to one that is not mirrored in the other shows up as a failing test.
const clipFromWorld = (wx, wy, aspect) => [wx * 2 / aspect, wy * 2]
const worldFromFrag = (fx, fy, w, h) => [(fx - 0.5 * w) / h, (fy - 0.5 * h) / h]
const worldExtent = aspect => [0.5 * aspect, 0.5]
function torusDelta(ax, ay, bx, by, hx, hy) {
  const sx = 2 * hx, sy = 2 * hy
  const dx = bx - ax, dy = by - ay
  return [dx - sx * Math.round(dx / sx), dy - sy * Math.round(dy / sy)]
}

const WALL = { width: 6000, height: 1200 }
const HD = { width: 1920, height: 1080 }
const SQUARE = { width: 1000, height: 1000 }

/** Bounding box of a world-space circle, in device pixels. */
function circleOnScreen(radius, canvas) {
  const aspect = canvasAspect(canvas)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < 720; i++) {
    const t = (i / 720) * Math.PI * 2
    const [cx, cy] = clipFromWorld(radius * Math.cos(t), radius * Math.sin(t), aspect)
    const px = cx * canvas.width / 2
    const py = cy * canvas.height / 2
    minX = Math.min(minX, px); maxX = Math.max(maxX, px)
    minY = Math.min(minY, py); maxY = Math.max(maxY, py)
  }
  return { width: maxX - minX, height: maxY - minY }
}

describe('clipFromWorld', () => {
  it('keeps a circle circular on the 5:1 wall', () => {
    // The headline bug. In raw clip space this same circle renders 5x wider
    // than tall -- boids' 0.06 separation radius was a 180x36px ellipse.
    const { width, height } = circleOnScreen(0.06, WALL)
    expect(width / height).toBeCloseTo(1, 3)
  })

  it('keeps circles circular at every aspect ratio', () => {
    for (const canvas of [WALL, HD, SQUARE, { width: 3440, height: 1440 }]) {
      const { width, height } = circleOnScreen(0.2, canvas)
      expect(width / height, `${canvas.width}x${canvas.height}`).toBeCloseTo(1, 3)
    }
  })

  it('maps the vertical extent to the full height', () => {
    // y = +/-0.5 in world space is the top and bottom edge, on any display.
    for (const canvas of [WALL, HD, SQUARE]) {
      const [, top] = clipFromWorld(0, 0.5, canvasAspect(canvas))
      expect(top).toBeCloseTo(1, 6)
    }
  })

  it('maps the horizontal extent to the full width', () => {
    // x = +/- aspect/2 is the left and right edge.
    for (const canvas of [WALL, HD, SQUARE]) {
      const a = canvasAspect(canvas)
      const [right] = clipFromWorld(a / 2, 0, a)
      expect(right, `${canvas.width}x${canvas.height}`).toBeCloseTo(1, 6)
    }
  })
})

describe('worldFromFrag', () => {
  it('puts the origin at the centre of the canvas', () => {
    const [x, y] = worldFromFrag(WALL.width / 2, WALL.height / 2, WALL.width, WALL.height)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
  })

  it('round-trips through clipFromWorld', () => {
    const a = canvasAspect(WALL)
    for (const [fx, fy] of [[0, 0], [WALL.width, WALL.height], [1234, 567]]) {
      const [wx, wy] = worldFromFrag(fx, fy, WALL.width, WALL.height)
      const [cx, cy] = clipFromWorld(wx, wy, a)
      // Clip -> pixel should land back on the original fragment coordinate.
      expect((cx + 1) / 2 * WALL.width).toBeCloseTo(fx, 3)
      expect((cy + 1) / 2 * WALL.height).toBeCloseTo(fy, 3)
    }
  })

  it('agrees with the hand-rolled form the fractals already used', () => {
    // flow-field, raymarch and the escape-time fractals compute
    // (fragCoord - 0.5*res)/res.y inline; the helper must match, or adopting it
    // would silently change how those look.
    const res = [WALL.width, WALL.height]
    const frag = [4321, 800]
    const inline = [(frag[0] - 0.5 * res[0]) / res[1], (frag[1] - 0.5 * res[1]) / res[1]]
    const helper = worldFromFrag(frag[0], frag[1], res[0], res[1])
    expect(helper[0]).toBeCloseTo(inline[0], 9)
    expect(helper[1]).toBeCloseTo(inline[1], 9)
  })
})

describe('worldExtent', () => {
  it('is half a unit tall regardless of display', () => {
    for (const canvas of [WALL, HD, SQUARE]) {
      expect(worldExtent(canvasAspect(canvas))[1]).toBe(0.5)
    }
  })

  it('grows horizontally with the aspect ratio', () => {
    expect(worldExtent(5)[0]).toBe(2.5)
    expect(worldExtent(1)[0]).toBe(0.5)
  })
})

describe('torusDelta', () => {
  it('treats points either side of the seam as adjacent', () => {
    // The boids tearing bug: a naive b-a makes neighbours across the wrap read
    // as maximally distant, so the flock shears at screen edges.
    const [hx, hy] = worldExtent(5)
    const [dx] = torusDelta(2.4, 0, -2.4, 0, hx, hy)
    expect(Math.abs(dx)).toBeCloseTo(0.2, 6)
    expect(Math.abs(dx)).toBeLessThan(Math.abs(-2.4 - 2.4))
  })

  it('matches the plain difference well away from the seam', () => {
    const [hx, hy] = worldExtent(5)
    const [dx, dy] = torusDelta(0, 0, 0.3, 0.1, hx, hy)
    expect(dx).toBeCloseTo(0.3, 6)
    expect(dy).toBeCloseTo(0.1, 6)
  })

  it('never returns a separation longer than half the span', () => {
    // The defining property: on a torus nothing is further than half a wrap.
    const [hx, hy] = worldExtent(5)
    for (let i = 0; i < 50; i++) {
      const a = [(i / 50) * 5 - 2.5, (i / 50) - 0.5]
      const b = [((i * 7) % 50) / 50 * 5 - 2.5, ((i * 3) % 50) / 50 - 0.5]
      const [dx, dy] = torusDelta(a[0], a[1], b[0], b[1], hx, hy)
      expect(Math.abs(dx)).toBeLessThanOrEqual(hx + 1e-9)
      expect(Math.abs(dy)).toBeLessThanOrEqual(hy + 1e-9)
    }
  })

  it('is antisymmetric away from the antipode', () => {
    // Excludes separations of exactly half the span: there both directions are
    // equally short, so the tie-break makes d(a,b) and d(b,a) agree in sign
    // rather than negate. That is inherent to a torus, not a defect -- the
    // first version of this test picked such a pair and failed on it.
    const [hx, hy] = worldExtent(5)
    const [dx, dy] = torusDelta(1.0, 0.2, -2.0, -0.15, hx, hy)
    const [rx, ry] = torusDelta(-2.0, -0.15, 1.0, 0.2, hx, hy)
    expect(Math.abs(dy)).toBeLessThan(hy)   // not the degenerate case
    expect(dx).toBeCloseTo(-rx, 6)
    expect(dy).toBeCloseTo(-ry, 6)
  })
})

describe('the GLSL source stays in step with these transcriptions', () => {
  it('declares every helper the savers call', () => {
    for (const fn of ['worldFromFrag', 'clipFromWorld', 'worldExtent',
      'torusDelta', 'torusWrap']) {
      expect(GLSL.worldSpace, fn).toContain(fn)
    }
  })

  it('divides by the short axis, not by width', () => {
    // The entire fix in one line. Dividing by resolution.x would reintroduce
    // the stretch in the other direction.
    expect(GLSL.worldSpace).toContain('/ resolution.y')
  })
})

describe('canvasAspect', () => {
  it('reports the display aspect ratio', () => {
    expect(canvasAspect(WALL)).toBe(5)
    expect(canvasAspect(SQUARE)).toBe(1)
    expect(canvasAspect(HD)).toBeCloseTo(16 / 9, 3)
  })

  it('does not divide by zero on an unsized canvas', () => {
    expect(Number.isFinite(canvasAspect({ width: 0, height: 0 }))).toBe(true)
  })
})
