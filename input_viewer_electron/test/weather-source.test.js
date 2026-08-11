// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * The weather poller (issue #101).
 *
 * #101 is explicit that the failure paths are the interesting part, and lists
 * them: no location configured, no route to host, a connection that opens and
 * times out, HTTP 429 and 500, malformed or partial JSON, and recovery after
 * hours offline. Each has a test here, driven through the real module with the
 * clock, timers and fetch injected -- no reimplementation.
 *
 * The behaviour these are protecting is that a failure must be *invisible* on the
 * no-signal path: never an unhandled rejection, never a blank canvas, and never a
 * leaked timer that outlives the screensaver.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createWeatherSource,
  parseReading,
  coarsen,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
  EXPIRE_AFTER_MS
} from '../src/renderer/screensavers/weather-source.js'

/** A controllable clock and timer queue, so nothing waits on real time. */
function harness() {
  let clock = 1_700_000_000_000
  let nextId = 1
  const timers = new Map()
  return {
    now: () => clock,
    advance(ms) { clock += ms },
    setTimer: (ms, fn) => {
      const id = nextId++
      timers.set(id, { at: clock + ms, fn })
      return id
    },
    clearTimer: (id) => { timers.delete(id) },
    pending: () => timers.size,
    /**
     * Drain the microtask queue. The poll chain is fetch -> json -> parse ->
     * finally -> schedule, so a couple of Promise.resolve() ticks is not enough
     * to see the next timer registered.
     */
    async flush(times = 20) {
      for (let i = 0; i < times; i++) await Promise.resolve()
    },
    /** Run every timer due at or before now+ms, advancing the clock. */
    async run(ms) {
      clock += ms
      const due = [...timers.entries()].filter(([, t]) => t.at <= clock)
      for (const [id, t] of due) { timers.delete(id); t.fn() }
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
  }
}

const CURRENT = {
  time: '2026-08-11T11:45',
  interval: 900,
  temperature_2m: 21.7,
  precipitation: 0.5,
  wind_speed_10m: 15.1,
  wind_direction_10m: 58,
  cloud_cover: 48,
  weather_code: 61,
  is_day: 1
}

const ok = (current = CURRENT) => ({
  ok: true,
  status: 200,
  json: async () => ({ current })
})

const config = (over = {}) => () => ({
  enabled: true, latitude: 52.3676, longitude: 4.9041, ...over
})

function build(fetchImpl, cfg = config(), h = harness()) {
  const src = createWeatherSource({
    getConfig: cfg,
    fetchImpl,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer
  })
  return { src, h }
}

describe('parseReading', () => {
  it('converts precipitation from mm-per-interval to mm/h', () => {
    // The issue's table says mm/h; the API actually reports mm accumulated over
    // `interval` seconds. 0.5mm per 900s is 2mm/h.
    const r = parseReading({ current: CURRENT })
    expect(r.precipitationMmH).toBeCloseTo(2, 6)
  })

  it('defaults a missing interval to 900s rather than dividing by zero', () => {
    const r = parseReading({ current: { ...CURRENT, interval: undefined } })
    expect(Number.isFinite(r.precipitationMmH)).toBe(true)
    expect(r.precipitationMmH).toBeCloseTo(2, 6)
  })

  it('treats a partial response as no reading', () => {
    // Temperature, wind and cloud drive the whole scene; a reading missing any
    // of them would render something confidently wrong.
    for (const missing of ['temperature_2m', 'wind_speed_10m', 'cloud_cover']) {
      const current = { ...CURRENT }
      delete current[missing]
      expect(parseReading({ current }), missing).toBeNull()
    }
  })

  it('tolerates missing optional fields', () => {
    const r = parseReading({
      current: { temperature_2m: 3, wind_speed_10m: 0, cloud_cover: 100 }
    })
    expect(r).not.toBeNull()
    expect(r.precipitationMmH).toBe(0)
    expect(r.windDirectionDeg).toBe(0)
    expect(r.isDay).toBe(false)
  })

  it('rejects junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { current: null }, { current: 'sunny' },
      { current: { temperature_2m: NaN, wind_speed_10m: 1, cloud_cover: 1 } }]) {
      expect(parseReading(junk)).toBeNull()
    }
  })

  it('clamps cloud cover into range', () => {
    expect(parseReading({ current: { ...CURRENT, cloud_cover: 140 } }).cloudCoverPct).toBe(100)
    expect(parseReading({ current: { ...CURRENT, cloud_cover: -5 } }).cloudCoverPct).toBe(0)
  })
})

describe('coarsen', () => {
  it('rounds coordinates to ~1km before they leave the process', () => {
    expect(coarsen(52.36757)).toBe(52.37)
    expect(coarsen(4.90414)).toBe(4.9)
    expect(coarsen(-0.126)).toBe(-0.13)
  })
})

describe('the happy path', () => {
  it('caches a reading and reports it', async () => {
    const f = vi.fn(async () => ok())
    const { src } = build(f)
    await src.pollNow()
    const r = src.getReading()
    expect(r.temperatureC).toBe(21.7)
    expect(r.stale).toBe(false)
    expect(src.getStatus().consecutiveFailures).toBe(0)
  })

  it('sends only coarsened coordinates', async () => {
    const f = vi.fn(async () => ok())
    const { src } = build(f)
    await src.pollNow()
    const url = f.mock.calls[0][0]
    expect(url).toContain('latitude=52.37')
    expect(url).toContain('longitude=4.9')
    expect(url).not.toContain('52.3676')
  })

  it('polls on the interval once healthy', async () => {
    const f = vi.fn(async () => ok())
    const { src, h } = build(f)
    src.start()
    await h.flush()
    expect(f).toHaveBeenCalledTimes(1)
    await h.run(POLL_INTERVAL_MS)
    expect(f).toHaveBeenCalledTimes(2)
    src.stop()
  })
})

describe('not configured', () => {
  it('makes no request and records no failure', async () => {
    const f = vi.fn(async () => ok())
    for (const cfg of [config({ enabled: false }), config({ latitude: null }),
      config({ longitude: null })]) {
      const { src } = build(f, cfg)
      await src.pollNow()
      expect(f).not.toHaveBeenCalled()
      expect(src.getStatus().consecutiveFailures).toBe(0)
      expect(src.getStatus().lastError).toBeNull()
      expect(src.getReading()).toBeNull()
    }
  })
})

describe('failure paths', () => {
  const cases = [
    ['no route to host', async () => { throw new TypeError('Failed to fetch') }],
    ['connection timeout', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }],
    ['HTTP 429', async () => ({ ok: false, status: 429, json: async () => ({}) })],
    ['HTTP 500', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['malformed JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } })],
    ['partial JSON', async () => ({ ok: true, status: 200, json: async () => ({ current: { temperature_2m: 9 } }) })],
    ['empty body', async () => ({ ok: true, status: 200, json: async () => null })]
  ]

  for (const [name, impl] of cases) {
    it(`${name}: never rejects, counts the failure, keeps no reading`, async () => {
      const { src } = build(vi.fn(impl))
      // The assertion that matters most: this does not throw. A rejection here
      // is the unhandled-rejection-on-the-no-signal-path bug from #101.
      await expect(src.pollNow()).resolves.toBeUndefined()
      expect(src.getStatus().consecutiveFailures).toBe(1)
      expect(src.getStatus().lastError).toBeTruthy()
      expect(src.getReading()).toBeNull()
    })
  }

  it('keeps animating the last good reading through a network blip', async () => {
    let mode = 'ok'
    const f = vi.fn(async () => (mode === 'ok' ? ok() : Promise.reject(new Error('down'))))
    const { src, h } = build(f)
    await src.pollNow()
    expect(src.getReading().temperatureC).toBe(21.7)

    mode = 'down'
    h.advance(60_000)
    await src.pollNow()
    // Still there: brief blips must be invisible.
    expect(src.getReading().temperatureC).toBe(21.7)
    expect(src.getStatus().consecutiveFailures).toBe(1)
  })

  it('backs off geometrically and caps at an hour', async () => {
    const { src } = build(vi.fn(async () => { throw new Error('down') }))
    const delays = []
    for (let i = 0; i < 8; i++) {
      await src.pollNow()
      delays.push(src.getStatus().nextDelayMs)
    }
    expect(delays[0]).toBe(60_000)
    expect(delays[1]).toBe(120_000)
    expect(delays[2]).toBe(240_000)
    // Monotonic, then flat at the cap -- never unbounded growth.
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    expect(Math.max(...delays)).toBe(60 * 60 * 1000)
  })

  it('recovers after hours offline and resets the backoff', async () => {
    let mode = 'down'
    const f = vi.fn(async () => (mode === 'ok' ? ok() : Promise.reject(new Error('down'))))
    const { src, h } = build(f)
    for (let i = 0; i < 20; i++) { h.advance(60 * 60 * 1000); await src.pollNow() }
    expect(src.getStatus().consecutiveFailures).toBe(20)

    mode = 'ok'
    await src.pollNow()
    expect(src.getStatus().consecutiveFailures).toBe(0)
    expect(src.getStatus().nextDelayMs).toBe(POLL_INTERVAL_MS)
    expect(src.getReading()).not.toBeNull()
  })

  it('accumulates no per-failure state over a long outage', async () => {
    // #101 warns about growing retry arrays on a wall that runs for weeks. The
    // status object must stay a fixed shape however many failures there are.
    const { src } = build(vi.fn(async () => { throw new Error('down') }))
    for (let i = 0; i < 500; i++) await src.pollNow()
    const status = src.getStatus()
    expect(Object.keys(status).sort()).toEqual(
      ['ageMs', 'consecutiveFailures', 'hasReading', 'lastError', 'nextDelayMs', 'running'])
    expect(status.consecutiveFailures).toBe(500)
  })
})

describe('staleness and expiry', () => {
  it('flags a reading as stale but keeps using it', async () => {
    const { src, h } = build(vi.fn(async () => ok()))
    await src.pollNow()
    h.advance(STALE_AFTER_MS + 1000)
    const r = src.getReading()
    expect(r).not.toBeNull()
    expect(r.stale).toBe(true)
    expect(r.ageMs).toBeGreaterThan(STALE_AFTER_MS)
  })

  it('stops offering a reading once it has expired', async () => {
    const { src, h } = build(vi.fn(async () => ok()))
    await src.pollNow()
    h.advance(EXPIRE_AFTER_MS + 1000)
    // Half a day old is worse than showing a different screensaver.
    expect(src.getReading()).toBeNull()
  })
})

describe('timer hygiene', () => {
  it('leaves no timer behind after stop()', async () => {
    const { src, h } = build(vi.fn(async () => ok()))
    src.start()
    await h.flush()
    await h.run(POLL_INTERVAL_MS)
    src.stop()
    expect(h.pending()).toBe(0)
  })

  it('survives repeated start/stop without piling up timers', async () => {
    const { src, h } = build(vi.fn(async () => ok()))
    for (let i = 0; i < 10; i++) {
      src.start()
      await h.flush()
      src.stop()
    }
    expect(h.pending()).toBe(0)
  })

  it('start() twice does not double the polling', async () => {
    const f = vi.fn(async () => ok())
    const { src, h } = build(f)
    src.start(); src.start()
    await h.flush()
    const afterStart = f.mock.calls.length
    await h.run(POLL_INTERVAL_MS)
    expect(f.mock.calls.length).toBe(afterStart + 1)
    src.stop()
  })

  it('does not run two requests at once', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    let concurrent = 0
    let maxConcurrent = 0
    const f = vi.fn(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await gate
      concurrent--
      return ok()
    })
    const { src } = build(f)
    const a = src.pollNow()
    const b = src.pollNow()
    release()
    await Promise.all([a, b])
    expect(maxConcurrent).toBe(1)
  })
})
