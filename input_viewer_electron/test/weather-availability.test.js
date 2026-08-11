// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Availability gating for the rotation (issue #101).
 *
 * This is the mechanism that replaces #101's broken fallback. The registry's
 * failure path is a `try { create(); start() } catch`, which cannot catch a fetch
 * that rejects after `start()` has returned -- so instead of failing late, the
 * weather saver declines to be picked until it has data, and the random rotation
 * skips it.
 *
 * The behaviour worth protecting: with no reading the wall never lands on it, and
 * the moment a reading exists it joins the rotation, with no restart.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { SCREENSAVERS, pickRandomIndex } from '../src/renderer/screensavers/registry.js'
import weather from '../src/renderer/screensavers/weather.js'
import { __injectReading } from '../src/renderer/screensavers/weather-source.js'
import { readoutText, classifyWeather } from '../src/renderer/screensavers/weather.js'
import { WEATHER_STATES } from '../src/renderer/screensavers/weather-states.js'

const READING = {
  temperatureC: 12, precipitationMmH: 0, windSpeedKmh: 5, windDirectionDeg: 0,
  cloudCoverPct: 50, weatherCode: 1, isDay: true
}

const weatherIndex = SCREENSAVERS.indexOf(weather)

/** Every index a full sweep of rand() can produce. */
function reachable(avoid = -1, samples = 4000) {
  const seen = new Set()
  for (let i = 0; i < samples; i++) seen.add(pickRandomIndex(avoid, () => i / samples))
  return seen
}

describe('the weather saver as a registry citizen', () => {
  afterEach(() => __injectReading(null))

  it('is registered', () => {
    expect(weatherIndex).toBeGreaterThanOrEqual(0)
  })

  it('declares isAvailable, which nothing else does', () => {
    expect(typeof weather.isAvailable).toBe('function')
    const others = SCREENSAVERS.filter((s) => s !== weather && typeof s.isAvailable === 'function')
    // Not a rule for its own sake: the point of the contract being optional is
    // that adding it did not touch 29 other modules.
    expect(others).toEqual([])
  })

  it('is unavailable with no reading, available with one', () => {
    __injectReading(null)
    expect(weather.isAvailable()).toBe(false)
    __injectReading(READING)
    expect(weather.isAvailable()).toBe(true)
  })
})

describe('the rotation', () => {
  afterEach(() => __injectReading(null))

  it('never picks the weather saver with no reading', () => {
    __injectReading(null)
    expect(reachable().has(weatherIndex)).toBe(false)
  })

  it('still reaches every other saver', () => {
    __injectReading(null)
    const seen = reachable()
    expect(seen.size).toBe(SCREENSAVERS.length - 1)
    for (let i = 0; i < SCREENSAVERS.length; i++) {
      if (i !== weatherIndex) expect(seen.has(i), `index ${i}`).toBe(true)
    }
  })

  it('picks it once a reading arrives, without a restart', () => {
    __injectReading(READING)
    expect(reachable().has(weatherIndex)).toBe(true)
  })

  it('still never repeats the previous pick', () => {
    // The guarantee availability filtering must not break.
    __injectReading(null)
    for (let avoid = 0; avoid < SCREENSAVERS.length; avoid++) {
      expect(reachable(avoid, 500).has(avoid), `avoid ${avoid}`).toBe(false)
    }
  })

  it('returns a valid index even if everything is unavailable', () => {
    // Defensive: a blank wall is worse than a repeat, so the filter falls back
    // to ignoring availability rather than returning nothing.
    const saved = SCREENSAVERS.map((s) => s.isAvailable)
    try {
      for (const s of SCREENSAVERS) s.isAvailable = () => false
      for (let i = 0; i < 200; i++) {
        const idx = pickRandomIndex(3, () => i / 200)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(SCREENSAVERS.length)
      }
    } finally {
      SCREENSAVERS.forEach((s, i) => {
        if (saved[i] === undefined) delete s.isAvailable
        else s.isAvailable = saved[i]
      })
    }
  })

  it('treats a throwing isAvailable as unavailable rather than propagating', () => {
    const original = weather.isAvailable
    try {
      weather.isAvailable = () => { throw new Error('boom') }
      // Must not throw: this runs on the no-signal path.
      expect(() => pickRandomIndex(-1, () => 0.5)).not.toThrow()
      expect(reachable().has(weatherIndex)).toBe(false)
    } finally {
      weather.isAvailable = original
    }
  })
})

describe('classifyWeather', () => {
  it('maps every WMO code in the API range to a known kind', () => {
    const kinds = new Set(['clear', 'cloud', 'fog', 'drizzle', 'rain', 'snow', 'storm'])
    for (let code = 0; code <= 99; code++) {
      const { kind, label } = classifyWeather(code)
      expect(kinds.has(kind), `code ${code} -> ${kind}`).toBe(true)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('picks out the states that change the scene, not just the label', () => {
    expect(classifyWeather(0).kind).toBe('clear')
    expect(classifyWeather(3).kind).toBe('cloud')
    expect(classifyWeather(45).kind).toBe('fog')
    expect(classifyWeather(65).kind).toBe('rain')
    expect(classifyWeather(73).kind).toBe('snow')
    expect(classifyWeather(95).kind).toBe('storm')
    expect(classifyWeather(99).kind).toBe('storm')
  })
})

describe('readoutText', () => {
  const CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:'

  it('only uses characters the glyph atlas can draw', () => {
    // A character outside the set renders as the blank glyph, so the readout
    // would silently lose text. Every canned state plus the fallback.
    for (const state of WEATHER_STATES) {
      const line = readoutText({ ageMs: 0, stale: false, ...state })
      for (const ch of line) {
        expect(CHARSET.includes(ch), `${JSON.stringify(ch)} in "${line}"`).toBe(true)
      }
    }
  })

  it('fits the shader uniform array', () => {
    for (const state of WEATHER_STATES) {
      expect(readoutText({ ageMs: 0, stale: false, ...state }).length).toBeLessThanOrEqual(56)
    }
  })

  it('shows the age when the reading is stale', () => {
    const line = readoutText({
      ...READING, ageMs: 42 * 60 * 1000, stale: true
    })
    expect(line).toContain('42 MIN AGO')
  })

  it('switches to hours for a very old reading', () => {
    const line = readoutText({ ...READING, ageMs: 3 * 60 * 60 * 1000, stale: true })
    expect(line).toContain('3 HOURS AGO')
  })

  it('says so plainly when there is no data at all', () => {
    // The fallback scene must not masquerade as a real observation.
    expect(readoutText({ ...READING, synthetic: true })).toContain('NO DATA')
  })

  it('reports temperature and condition for a normal reading', () => {
    const line = readoutText({ ...READING, temperatureC: 21.7, weatherCode: 61 })
    expect(line).toContain('21.7C')
    expect(line).toContain('RAIN')
    expect(line).not.toContain('AGO')
    expect(line).not.toContain('NO DATA')
  })

  it('omits wind and rain when there is none to report', () => {
    const line = readoutText({
      ...READING, windSpeedKmh: 0, precipitationMmH: 0, weatherCode: 0
    })
    expect(line).not.toContain('WIND')
    expect(line).not.toContain('MM-H')
  })
})
