// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
import { describe, it, expect } from 'vitest'
import { pointScale, particleSide } from '../src/renderer/screensavers/gl-base.js'

// Canvas stand-in: these helpers only read width/height.
const canvas = (width, height) => ({ width, height })

const LAPTOP = canvas(1440, 900)
const HD = canvas(1920, 1080)
const QHD = canvas(2560, 1440)
const UHD = canvas(3840, 2160)
// The install this scaling exists for: 6000x1200 is only marginally taller
// than 1080p but 3.5x its area, which is why area (not either axis) drives it.
const WALL = canvas(6000, 1200)

describe('pointScale', () => {
  it('leaves 1080p and smaller untouched', () => {
    expect(pointScale(HD, 1.5)).toBe(1)
    expect(pointScale(LAPTOP, 1.5)).toBe(1)
  })

  it('floors small points to a resolvable size on large displays', () => {
    // A 1px dot on the wall is sub-resolvable at viewing distance; the floor
    // is what makes these screensavers visible at all.
    expect(1.0 * pointScale(WALL, 1.0)).toBeCloseTo(4, 5)
    expect(1.5 * pointScale(WALL, 1.5)).toBeCloseTo(4, 5)
    expect(2.0 * pointScale(WALL, 2.0)).toBeCloseTo(4, 5)
  })

  it('does not shrink points that are already large enough', () => {
    // boids' 2.5px base is above the floor, so area scaling governs instead.
    expect(2.5 * pointScale(WALL, 2.5)).toBeGreaterThanOrEqual(4)
  })

  it('never scales below 1x', () => {
    for (const c of [LAPTOP, HD, QHD, UHD, WALL]) {
      expect(pointScale(c, 1.0)).toBeGreaterThanOrEqual(1)
    }
  })

  it('is bounded so huge canvases cannot produce absurd points', () => {
    expect(pointScale(canvas(15360, 8640), 1.0)).toBeLessThanOrEqual(4)
  })

  it('survives a zero-sized canvas without dividing by zero', () => {
    expect(Number.isFinite(pointScale(canvas(0, 0), 1.0))).toBe(true)
  })
})

describe('particleSide', () => {
  it('leaves 1080p and smaller at the tuned base count', () => {
    expect(particleSide(HD, 256, 384)).toBe(256)
    expect(particleSide(LAPTOP, 256, 384)).toBe(256)
  })

  it('never scales down below the base', () => {
    // Thinning a laptop preview would misrepresent what the wall shows.
    expect(particleSide(canvas(640, 480), 256, 384)).toBe(256)
  })

  it('scales up with area, holding density roughly constant', () => {
    // Count is SIDE^2, so SIDE grows with sqrt(area) to grow count linearly.
    const side = particleSide(QHD, 256, 384)
    expect(side).toBeGreaterThan(256)
    const density = (2560 * 1440) / (side * side)
    const baseDensity = (1920 * 1080) / (256 * 256)
    expect(density / baseDensity).toBeLessThan(1.2)
  })

  it('respects the cap so cost stays bounded on the wall', () => {
    expect(particleSide(WALL, 256, 384)).toBe(384)
    expect(particleSide(canvas(15360, 8640), 256, 384)).toBe(384)
  })

  it('honours a lower cap for expensive simulations', () => {
    // boids costs COUNT * SAMPLES, so it caps far lower than the plain fields.
    expect(particleSide(WALL, 64, 128)).toBeLessThanOrEqual(128)
    expect(particleSide(WALL, 64, 128)).toBeGreaterThan(64)
  })

  it('returns a multiple of 8 so textures stay friendly', () => {
    for (const c of [QHD, UHD, WALL]) {
      expect(particleSide(c, 256, 384) % 8).toBe(0)
      expect(particleSide(c, 64, 128) % 8).toBe(0)
    }
  })

  it('returns a usable side for a zero-sized canvas', () => {
    expect(particleSide(canvas(0, 0), 256, 384)).toBe(256)
  })
})
