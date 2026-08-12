// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
//
// The owner rejected the gold/amber look Reaction Diffusion kept landing on, so
// the base hue is picked from a curated list instead of being a free random.
//
// This suite re-derives that guarantee rather than trusting the list. It reads
// the drift coefficients out of the shader source and converts real OKLab ramp
// values to sRGB, so it fails if ANY of three things drifts apart:
//
//   - an entry is added to PALETTE_BASE_HUES that is not actually safe,
//   - the shader's hue drift widens (a wider arc can reach the band from a base
//     that used to be clear),
//   - oklabRamp's lightness/chroma for the tissue highlight changes.
//
// The third is the subtle one and is why the band is measured here instead of
// hardcoded: gold's position in turns is a property of L and C, not a constant.
//
// Source is parsed rather than imported. reaction-diffusion.js pulls in gl-base
// and post-fx, which expect a browser; the DOM-free node environment is the fast
// default here (see CLAUDE.md), and a static check needs no context.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/renderer/screensavers/reaction-diffusion.js', import.meta.url)),
  'utf8')

// The tissue highlight, from `oklabRamp(hue, mix(0.42, 0.80, h), 0.12, 0.0)` at
// h = 1. This is the brightest, most chromatic thing on screen and therefore
// what a viewer reads as "the colour".
const TISSUE_L = 0.80
const TISSUE_C = 0.12

// Gold and amber as an objective interval in HSV hue degrees. Anything from a
// warm orange through to a yellow-gold; above 50 is a green-leaning yellow,
// below 14 is unambiguously red.
const AMBER_LO_DEG = 14
const AMBER_HI_DEG = 50

// The window in turns the curated list was built to avoid: the measured gold/amber
// band (0.105 .. 0.260 at this L and C) plus a margin either side. Every curated
// base is chosen so its entire swept arc stays outside this.
const EXCLUDED_LO = 0.09
const EXCLUDED_HI = 0.28

function oklabToLinear (L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  ]
}

function toSrgb (c) {
  const v = Math.min(1, Math.max(0, c))
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

// Mirrors oklabRamp() in glsl-lib.js with hueTurns = 0.
function ramp (turns, L, C) {
  const h = 2 * Math.PI * turns
  return oklabToLinear(L, C * Math.cos(h), C * Math.sin(h)).map(toSrgb)
}

function hueDegrees ([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (d < 1e-6) return null            // achromatic: no hue to be wrong about
  let deg
  if (mx === r) deg = 60 * (((g - b) / d) % 6)
  else if (mx === g) deg = 60 * ((b - r) / d + 2)
  else deg = 60 * ((r - g) / d + 4)
  return (deg + 360) % 360
}

const isAmber = turns => {
  const deg = hueDegrees(ramp(turns, TISSUE_L, TISSUE_C))
  return deg !== null && deg >= AMBER_LO_DEG && deg < AMBER_HI_DEG
}

describe('reaction diffusion palette', () => {
  // Parsed, not duplicated, so the test cannot pass against a stale copy.
  const hues = (() => {
    const block = SRC.match(/export const PALETTE_BASE_HUES = \[([\s\S]*?)\]/)
    expect(block, 'PALETTE_BASE_HUES not found — was it renamed?').toBeTruthy()
    return [...block[1].matchAll(/^\s*(\d*\.?\d+),?\s*\/\//gm)].map(m => Number(m[1]))
  })()

  // `hue = uPhase.x + 0.13 * rc + 0.08 * h + 0.015 * sin(uTime * 0.05)`.
  // rc and h are both clamp/smoothstep results in [0,1], so the positive terms
  // sum to the upper drift and the sin term supplies the lower.
  const drift = (() => {
    const m = SRC.match(
      /float hue = uPhase\.x \+ ([\d.]+) \* rc \+ ([\d.]+) \* h \+ ([\d.]+) \* sin/)
    expect(m, 'hue expression not found — the drift terms may have changed shape').toBeTruthy()
    const [, rc, h, osc] = m.map(Number)
    return { lo: -osc, hi: rc + h + osc }
  })()

  it('parses a non-trivial curated list and the shader drift', () => {
    expect(hues.length).toBeGreaterThanOrEqual(6)
    expect(new Set(hues).size).toBe(hues.length)
    for (const t of hues) expect(t).toBeGreaterThanOrEqual(0)
    for (const t of hues) expect(t).toBeLessThan(1)
    // If this ever fails the arc has widened and the list needs re-deriving.
    expect(drift.hi - drift.lo).toBeCloseTo(0.24, 2)
  })

  it('confines gold/amber to the band the curation excluded', () => {
    // Guards the assumption the list was built on. If L or C changed, gold moves
    // and the whole exclusion is void.
    //
    // Asserts containment in the excluded window rather than the exact edges: the
    // measured edge depends on sampling resolution (a 50-step scan reads 0.12
    // where a 1000-step scan reads 0.105), and it is containment, not the edge
    // value, that makes the curated list safe.
    const band = []
    for (let i = 0; i < 2000; i++) if (isAmber(i / 2000)) band.push(i / 2000)
    expect(band.length).toBeGreaterThan(0)
    expect(Math.min(...band)).toBeGreaterThanOrEqual(EXCLUDED_LO)
    expect(Math.max(...band)).toBeLessThanOrEqual(EXCLUDED_HI)
    // A band this narrow would mean the ramp had lost its warm sector entirely,
    // which would make the exclusion meaningless rather than satisfied.
    expect(Math.max(...band) - Math.min(...band)).toBeGreaterThan(0.10)
  })

  it('never reaches gold or amber from any curated base', () => {
    // The whole swept arc, not just the base — a base adjacent to the band walks
    // into it, which is the trap this test exists to catch.
    for (const base of hues) {
      for (let k = 0; k <= 200; k++) {
        const t = base + drift.lo + (drift.hi - drift.lo) * (k / 200)
        const turns = ((t % 1) + 1) % 1
        const deg = hueDegrees(ramp(turns, TISSUE_L, TISSUE_C))
        expect(
          isAmber(turns),
          `base ${base} reaches turn ${turns.toFixed(3)} = hue ${deg?.toFixed(0)}deg, inside gold/amber`
        ).toBe(false)
      }
    }
  })

  it('still spans a wide range of looks', () => {
    // A curated list that collapsed to one hue would pass the exclusion above
    // while destroying the per-activation variety that made a list preferable to
    // simply clamping to a single safe arc.
    const degs = hues.map(t => hueDegrees(ramp(t, TISSUE_L, TISSUE_C)))
    expect(Math.max(...degs) - Math.min(...degs)).toBeGreaterThan(150)
  })

  it('picks the base hue from the list rather than a free random', () => {
    expect(SRC).toMatch(/palettePhase = \[rng\.pick\(PALETTE_BASE_HUES\)/)
  })
})
