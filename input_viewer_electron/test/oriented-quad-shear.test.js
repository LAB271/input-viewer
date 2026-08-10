// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Oriented quads must not be sheared by the display aspect (issue #190).
 *
 * `orientedQuadOffset` rotates a quad corner onto a velocity heading. It is only
 * correct if the size it is given is **isotropic** in the space it is working
 * in. boids.js folded `uQuadScale` -- the per-axis pixel-to-clip conversion --
 * into the size *before* the rotation, which rotates an already anisotropically
 * scaled corner. That shears the quad, by a factor of the aspect ratio: 5x on
 * the 6000x1200 wall, and essentially invisible at 16:9, which is how it lasted.
 *
 * The GLSL cannot be executed here, so both orderings are transcribed into JS,
 * following the same approach as screensaver-aspect.test.js. That pins the
 * arithmetic, which is the part that was wrong.
 *
 * The invariant under test: rotating a shape must not change its dimensions.
 * A quad's two edge lengths are rotation-invariant, so if they vary with the
 * boid's heading, the shape is being distorted rather than turned.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// The four corners orientedQuadOffset receives, in [-0.5, 0.5].
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]

/** Transcription of GLSL.orientedQuadOffset from glsl-lib.js. */
function orientedQuadOffset(corner, vel, size, stretch) {
  const speed = Math.hypot(vel[0], vel[1])
  const dir = speed > 1e-4 ? [vel[0] / speed, vel[1] / speed] : [1, 0]
  const perp = [-dir[1], dir[0]]
  const c = [corner[0] * size[0], corner[1] * size[1]]
  return [
    dir[0] * (c[0] * stretch) + perp[0] * c[1],
    dir[1] * (c[0] * stretch) + perp[1] * c[1]
  ]
}

// Pixel -> clip conversion, exactly as boids.js uploads it. Per-axis, and on a
// 5:1 canvas the two components differ by 5x -- that difference is the bug.
const quadScale = (w, h) => [2 / w, 2 / h]

/** The buggy ordering: scale anisotropically, then rotate. */
function offsetsBefore(vel, sizePx, qs, stretch) {
  const size = [sizePx * qs[0], sizePx * qs[1]]
  return CORNERS.map((c) => orientedQuadOffset(c, vel, size, stretch))
}

/** The fixed ordering: rotate in isotropic pixel space, then convert to clip. */
function offsetsAfter(vel, sizePx, qs, stretch) {
  const offs = CORNERS.map((c) => orientedQuadOffset(c, vel, [sizePx, sizePx], stretch))
  return offs.map(([x, y]) => [x * qs[0], y * qs[1]])
}

/**
 * The quad's two edge lengths **in device pixels**, which is what the eye sees.
 * Clip offsets are converted back through the canvas size.
 */
function edgeLengthsPx(offsets, w, h) {
  const px = offsets.map(([x, y]) => [x * w / 2, y * h / 2])
  const edge = (a, b) => Math.hypot(px[b][0] - px[a][0], px[b][1] - px[a][1])
  return [edge(0, 1), edge(1, 2)]
}

const WALL = [6000, 1200]   // 5:1
const HD = [1920, 1080]     // 16:9
const STRETCH = 2.2         // boids' arrowhead elongation
const SIZE_PX = 2.5

/** Headings spanning a full turn, including the axis-aligned special cases. */
const HEADINGS = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2
  return [Math.cos(a), Math.sin(a)]
})

/** Spread of a measurement across all headings, as a fraction of its mean. */
function spread(values) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return (max - min) / ((min + max) / 2)
}

describe('orientedQuadOffset shear (#190)', () => {
  it('the fixed ordering keeps the quad rigid as it rotates', () => {
    for (const [w, h] of [WALL, HD]) {
      const qs = quadScale(w, h)
      const longEdges = []
      const shortEdges = []
      for (const vel of HEADINGS) {
        const [a, b] = edgeLengthsPx(offsetsAfter(vel, SIZE_PX, qs, STRETCH), w, h)
        longEdges.push(a)
        shortEdges.push(b)
      }
      // Rotation preserves lengths, so both edges must be constant.
      expect(spread(longEdges)).toBeLessThan(1e-9)
      expect(spread(shortEdges)).toBeLessThan(1e-9)
    }
  })

  it('the old ordering distorted the quad by the aspect ratio on the wall', () => {
    // Guards against the fix being reverted or reintroduced elsewhere: this
    // documents the magnitude of what was wrong.
    const [w, h] = WALL
    const qs = quadScale(w, h)
    const longEdges = HEADINGS.map((vel) =>
      edgeLengthsPx(offsetsBefore(vel, SIZE_PX, qs, STRETCH), w, h)[0])
    // A 5:1 canvas made the arrowhead's length swing by ~4x across headings.
    expect(spread(longEdges)).toBeGreaterThan(1)
  })

  it('explains why nobody noticed at 16:9', () => {
    const [w, h] = HD
    const qs = quadScale(w, h)
    const longEdges = HEADINGS.map((vel) =>
      edgeLengthsPx(offsetsBefore(vel, SIZE_PX, qs, STRETCH), w, h)[0])
    // Still wrong, but a 16:9 swing this small on a 2.5px sprite is invisible.
    const s = spread(longEdges)
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(0.7)
  })

  it('is unaffected on a square canvas, where the conversion is isotropic', () => {
    const qs = quadScale(1000, 1000)
    const before = offsetsBefore([0.6, 0.8], SIZE_PX, qs, STRETCH)
    const after = offsetsAfter([0.6, 0.8], SIZE_PX, qs, STRETCH)
    for (let i = 0; i < before.length; i++) {
      expect(before[i][0]).toBeCloseTo(after[i][0], 12)
      expect(before[i][1]).toBeCloseTo(after[i][1], 12)
    }
  })

  it('still elongates along travel -- the fix must not flatten the arrowhead', () => {
    const [w, h] = WALL
    const qs = quadScale(w, h)
    const [long, short] = edgeLengthsPx(offsetsAfter([1, 0], SIZE_PX, qs, STRETCH), w, h)
    expect(long / short).toBeCloseTo(STRETCH, 6)
  })
})

/**
 * The arithmetic above proves which ordering is correct; this proves the savers
 * actually use it. Without this, boids.js could drift back to the buggy form and
 * every test in this file would still pass.
 */
describe('no saver folds uQuadScale into an orientedQuadOffset size', () => {
  const dir = path.join(import.meta.dirname, '..', 'src', 'renderer', 'screensavers')
  const callers = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, readFileSync(path.join(dir, f), 'utf8')])
    .filter(([, src]) => /orientedQuadOffset\s*\(/.test(src))

  it('finds the savers that build oriented quads', () => {
    // If this drops to zero the checks below are vacuous.
    expect(callers.length).toBeGreaterThan(0)
  })

  for (const [file, src] of callers) {
    it(`${file} converts to clip on the result, not the size`, () => {
      // Any `vec2 <name> = ... uQuadScale ...` that is then passed as the size
      // argument is the bug. Match the size expression per call site.
      const calls = [...src.matchAll(/orientedQuadOffset\(\s*([^,]+),\s*([^,]+),/g)]
      expect(calls.length).toBeGreaterThan(0)
      for (const [, , sizeArg] of calls) {
        const name = sizeArg.trim()
        if (/uQuadScale/.test(name)) {
          throw new Error(`${file}: uQuadScale passed directly as the size argument`)
        }
        // Follow a local `vec2 name = <expr>` declaration and check that too.
        const decl = new RegExp(`vec2\\s+${name.replace(/[^\w]/g, '')}\\s*=\\s*([^;]+);`)
        const m = decl.exec(src)
        if (m) {
          expect(m[1], `${file}: size "${name}" has uQuadScale folded in before rotation`)
            .not.toMatch(/uQuadScale/)
        }
      }
    })
  }
})
