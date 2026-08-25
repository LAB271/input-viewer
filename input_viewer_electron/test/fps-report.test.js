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

/** A sample carrying per-frame work, in total ms across the interval. */
const timed = (label, frames, seconds, preMs, drawMs) =>
  ({ label, frames, seconds, preMs, drawMs, width: 6000, height: 1200 })

/** A sample carrying jank: worst single gap, late count, and their spacing. */
const janky = (label, frames, seconds, worstMs, lateCount, latePeriodMs) =>
  ({ label, frames, seconds, preMs: 0, drawMs: 0, worstMs, lateCount, latePeriodMs,
     width: 6000, height: 1200 })

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

describe('the timing split says where the frame went', () => {
  it('averages pre and draw per frame, not per interval', () => {
    // 600 frames over 10s having spent 1200ms drawing is 2ms a frame.
    const stats = accumulateFrameStats([timed('Plasma', 600, 10, 300, 1200)], new Map())
    const body = formatFpsReport(stats)
    // Table: saver fps work frame worst late every n size
    const row = body.split('\n').find(l => l.startsWith('Plasma')).split(/\s+/)
    expect(Number(row[1])).toBeCloseTo(60, 1)   // fps
    expect(Number(row[2])).toBeCloseTo(2.5, 2)  // work = pre + draw
    // draw and pre moved to a detail line, so the table stays readable on a terminal.
    const detail = body.split('\n').find(l => l.trim().startsWith('Plasma') && l.includes('draw'))
    expect(detail).toMatch(/draw 2\.00ms/)
    expect(detail).toMatch(/pre 0\.50ms/)
  })

  it('reports the achieved frame interval and the wait left over', () => {
    // The point of the whole column set: at 60fps the interval is 16.67ms, and
    // spending 2.5ms of it means 14.17ms was spent waiting on something else.
    // That is what distinguishes "our JS is slow" from "we are not the bottleneck".
    const stats = accumulateFrameStats([timed('Plasma', 600, 10, 300, 1200)], new Map())
    const row = formatFpsReport(stats).split('\n')
      .find(l => l.startsWith('Plasma')).split(/\s+/)
    expect(Number(row[3])).toBeCloseTo(16.67, 1)  // frame
    // wait is frame - work, still stated in the header rather than a column.
    expect(Number(row[3]) - Number(row[2])).toBeCloseTo(14.17, 1)
  })

  it('shows a loop that IS the bottleneck as almost no wait', () => {
    // 450 frames over 10s having spent 21ms each drawing: work ~= frame, wait ~= 0.
    // This is the shape that would indict the render loop itself.
    //
    // 10s not 1s: a shorter interval is discarded by FPS_MIN_SAMPLE_SECONDS, which
    // is the guard against a saver that started or stopped mid-interval.
    const stats = accumulateFrameStats([timed('Heavy', 450, 10, 0, 9450)], new Map())
    const row = formatFpsReport(stats).split('\n')
      .find(l => l.startsWith('Heavy')).split(/\s+/)
    expect(Number(row[2])).toBeCloseTo(21, 0)   // work
    expect(Number(row[3])).toBeCloseTo(22.2, 0) // frame
    expect(Number(row[3]) - Number(row[2])).toBeLessThan(2) // wait
  })

  it('accumulates timing across intervals like the counts', () => {
    const stats = new Map()
    accumulateFrameStats([timed('Plasma', 600, 10, 0, 1200)], stats)
    accumulateFrameStats([timed('Plasma', 600, 10, 0, 600)], stats)
    const v = stats.get('Plasma')
    expect(v.drawMs).toBe(1800)
    expect(v.frames).toBe(1200)
    // 1800ms over 1200 frames = 1.5ms mean, not the mean of 2 and 1.
    const detail = formatFpsReport(stats).split('\n')
      .find(l => l.trim().startsWith('Plasma') && l.includes('draw'))
    expect(detail).toMatch(/draw 1\.50ms/)
  })

  it('tolerates samples with no timing, so an old runtime cannot break it', () => {
    // sampleFrameCounters is the only producer, but defaulting rather than
    // throwing means a partially-updated build reports counts instead of nothing.
    const stats = accumulateFrameStats([sample('Plasma', 600, 10)], new Map())
    expect(stats.get('Plasma').drawMs).toBe(0)
    expect(() => formatFpsReport(stats)).not.toThrow()
  })

  it('explains its own columns in the file', () => {
    // Read on a wall, by someone who did not write it.
    const stats = accumulateFrameStats([timed('Plasma', 600, 10, 0, 1200)], new Map())
    const body = formatFpsReport(stats)
    expect(body).toContain('work = pre + draw')
    expect(body).toContain('wait = frame - work')
  })
})

describe('jank the averages cannot show', () => {
  // The reason these exist: #279 replaced min/max with the timing split, and a mean
  // over 15s hides a dropped frame. Four dropped frames in a 15s window move the mean
  // from 16.67ms to 16.74ms -- which is exactly what the wall reported while a
  // periodic freeze was plainly visible on it.

  it('keeps the WORST gap, never an average of gaps', () => {
    // Averaging the worst case is how the last version lost the signal.
    const stats = new Map()
    accumulateFrameStats([janky('Plasma', 900, 15, 18, 1, 0)], stats)
    accumulateFrameStats([janky('Plasma', 900, 15, 214, 8, 1900)], stats)
    accumulateFrameStats([janky('Plasma', 900, 15, 20, 1, 0)], stats)
    expect(stats.get('Plasma').worstMs).toBe(214)
  })

  it('totals late frames across windows', () => {
    const stats = new Map()
    accumulateFrameStats([janky('Plasma', 900, 15, 40, 7, 2000)], stats)
    accumulateFrameStats([janky('Plasma', 900, 15, 40, 8, 2000)], stats)
    expect(stats.get('Plasma').lateCount).toBe(15)
  })

  it('reports the spacing between late frames, which names the cause', () => {
    // A cadence at ~1600ms is the detection cycle; ~5000 the board refresh; ~15000
    // the sampler itself. The period is the diagnostic, not the count.
    const stats = accumulateFrameStats(
      [janky('Plasma', 900, 15, 210, 9, 1604)], new Map())
    const row = formatFpsReport(stats).split('\n')
      .find(l => l.startsWith('Plasma')).split(/\s+/)
    // saver fps work frame worst late every n size
    expect(Number(row[4])).toBeCloseTo(210, 0)   // worst
    expect(Number(row[5])).toBe(9)               // late
    expect(Number(row[6])).toBeCloseTo(1604, 0)  // every
  })

  it('shows a dash rather than a fake period when nothing was late', () => {
    // A single late frame has no spacing, and printing 0 would read as "every 0ms".
    const stats = accumulateFrameStats(
      [janky('Plasma', 900, 15, 18, 0, 0)], new Map())
    const row = formatFpsReport(stats).split('\n')
      .find(l => l.startsWith('Plasma')).split(/\s+/)
    expect(row[6]).toBe('-')
  })

  it('averages the period across windows that had one', () => {
    // Windows with no late frames must not drag the mean toward zero.
    const stats = new Map()
    accumulateFrameStats([janky('Plasma', 900, 15, 200, 8, 1600)], stats)
    accumulateFrameStats([janky('Plasma', 900, 15, 12, 0, 0)], stats)
    accumulateFrameStats([janky('Plasma', 900, 15, 200, 8, 1620)], stats)
    const row = formatFpsReport(stats).split('\n')
      .find(l => l.startsWith('Plasma')).split(/\s+/)
    expect(Number(row[6])).toBeCloseTo(1610, 0)
  })

  it('explains in the file what a cadence would mean', () => {
    // Read on a wall by someone who did not write it, next to a number like 1604.
    const body = formatFpsReport(accumulateFrameStats(
      [janky('Plasma', 900, 15, 200, 8, 1600)], new Map()))
    expect(body).toContain('1600 detection cycle')
    expect(body).toContain('names the cause')
  })

  it('tolerates samples with no jank fields', () => {
    const stats = accumulateFrameStats([sample('Plasma', 600, 10)], new Map())
    expect(stats.get('Plasma').worstMs).toBe(0)
    expect(() => formatFpsReport(stats)).not.toThrow()
  })
})
