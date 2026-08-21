// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Frame-rate instrumentation.
 *
 * The wall reports lag that no measurement on a dev machine reproduces, and the
 * GPU report established the hardware is healthy. This is the next instrument, so
 * the arithmetic behind it is worth pinning: a wrong number here would send the
 * next round of diagnosis somewhere useless.
 *
 * The counter itself lives in gl-base's frame loop and needs GL to exercise, so
 * these cover the folding and formatting -- which is where a bug would actually
 * hide.
 */
import { describe, it, expect, vi } from 'vitest'
import { installRendererDom } from './helpers/renderer-dom.js'

installRendererDom()

const fakeTrack = () => ({
  stop: vi.fn(),
  getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
  getCapabilities: () => ({
    width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 }
  })
})
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [fakeTrack()],
      getVideoTracks: () => [fakeTrack()],
      getAudioTracks: () => [],
    })),
    enumerateDevices: vi.fn(async () => []),
  },
  configurable: true,
})

const { accumulateFrameStats, formatFpsReport } =
  await import('../src/renderer/renderer.js')

const sample = (label, frames, seconds, width = 6000, height = 1200) =>
  ({ label, frames, seconds, width, height })

describe('accumulateFrameStats', () => {
  it('turns frames over an interval into a rate', () => {
    const stats = accumulateFrameStats([sample('Plasma', 600, 10)], new Map())
    const v = stats.get('Plasma')
    expect(v.frames / v.seconds).toBeCloseTo(60, 5)
    expect(v.samples).toBe(1)
    expect(v.size).toBe('6000x1200')
  })

  it('accumulates across rounds rather than replacing', () => {
    const stats = new Map()
    accumulateFrameStats([sample('Plasma', 600, 10)], stats)
    accumulateFrameStats([sample('Plasma', 300, 10)], stats)
    const v = stats.get('Plasma')
    expect(v.samples).toBe(2)
    // The mean is over total frames and total seconds, not a mean of means --
    // otherwise two unequal intervals would weight wrongly.
    expect(v.frames / v.seconds).toBeCloseTo(45, 5)
  })

  it('tracks the worst and best interval, not just the average', () => {
    // A saver that averages 60 but drops to 8 for one interval is the interesting
    // case, and a mean alone hides it.
    const stats = new Map()
    accumulateFrameStats([sample('Raymarch', 600, 10)], stats)
    accumulateFrameStats([sample('Raymarch', 80, 10)], stats)
    accumulateFrameStats([sample('Raymarch', 900, 10)], stats)
    const v = stats.get('Raymarch')
    expect(v.min).toBeCloseTo(8, 5)
    expect(v.max).toBeCloseTo(90, 5)
    expect(v.last).toBeCloseTo(90, 5)
  })

  it('discards an interval too short to mean anything', () => {
    // A saver that started or stopped mid-interval drew for part of it; dividing by
    // the whole interval would invent a low frame rate that never happened.
    const stats = accumulateFrameStats([sample('Frost', 4, 0.5)], new Map())
    expect(stats.size).toBe(0)
  })

  it('keeps concurrent runtimes apart', () => {
    // Dual view with no signal runs two boards plus possibly a saver, each its own
    // runtime. An aggregate would hide one side being slower than the other.
    const stats = accumulateFrameStats([
      sample('Split Flap (left)', 600, 10, 3000, 1200),
      sample('Split Flap (right)', 120, 10, 3000, 1200),
    ], new Map())
    expect(stats.get('Split Flap (left)').frames / 10).toBeCloseTo(60, 5)
    expect(stats.get('Split Flap (right)').frames / 10).toBeCloseTo(12, 5)
    expect(stats.get('Split Flap (left)').size).toBe('3000x1200')
  })

  it('records the size, so a figure cannot be read at the wrong resolution', () => {
    // Every fps number in this repo has been misread at least once for want of the
    // resolution it was taken at (#225).
    const stats = accumulateFrameStats(
      [sample('Mandelbrot', 300, 10, 3000, 600)], new Map())
    expect(stats.get('Mandelbrot').size).toBe('3000x600')
  })
})

describe('formatFpsReport', () => {
  it('puts the slowest first, because that is the question being asked', () => {
    const stats = accumulateFrameStats([
      sample('Fast', 1200, 10),
      sample('Slow', 100, 10),
      sample('Middle', 600, 10),
    ], new Map())
    const body = formatFpsReport(stats)
    const order = body.split('\n')
      .filter(l => /^(Fast|Slow|Middle)/.test(l))
      .map(l => l.split(/\s+/)[0])
    expect(order).toEqual(['Slow', 'Middle', 'Fast'])
  })

  it('says so plainly when nothing has been counted', () => {
    expect(formatFpsReport(new Map())).toContain('No frames counted yet')
  })

  it('states the overwrite discipline in the file itself', () => {
    // The disk behaviour was an explicit requirement, so the file says what it does
    // rather than leaving a reader to wonder whether it grows.
    expect(formatFpsReport(new Map())).toContain('nothing here is appended')
  })

  it('carries the resolution on every row', () => {
    const stats = accumulateFrameStats(
      [sample('Plasma', 600, 10, 6000, 1200)], new Map())
    expect(formatFpsReport(stats)).toContain('6000x1200')
  })

  it('stays one line per saver, so the file cannot grow with uptime', () => {
    // The bound that matters: rows are per label, not per sample.
    const stats = new Map()
    for (let i = 0; i < 50; i++) {
      accumulateFrameStats([sample('Plasma', 600, 10)], stats)
    }
    const rows = formatFpsReport(stats).split('\n').filter(l => l.startsWith('Plasma'))
    expect(rows).toHaveLength(1)
    expect(stats.get('Plasma').samples).toBe(50)
  })
})
