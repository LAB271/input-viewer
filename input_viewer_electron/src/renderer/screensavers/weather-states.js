// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Canned weather readings for reviewing the weather screensaver (issue #101).
 *
 * The interesting states cannot be reviewed by waiting for the weather to
 * oblige, so these are the ones worth looking at deliberately. Driven by the W
 * key in preview.js and by the screenshot harness; nothing in the shipped app
 * reads this file.
 *
 * Values are plausible rather than extreme -- the point is to check the display
 * against readings it will actually receive. `precipitationMmH` is a rate, which
 * is what weather-source.js produces after converting the API's mm-per-interval.
 */
export const WEATHER_STATES = [
  {
    label: 'clear day',
    temperatureC: 24.3, precipitationMmH: 0, windSpeedKmh: 7, windDirectionDeg: 200,
    cloudCoverPct: 4, weatherCode: 0, isDay: true
  },
  {
    label: 'partly cloudy, breezy',
    temperatureC: 17.1, precipitationMmH: 0, windSpeedKmh: 26, windDirectionDeg: 250,
    cloudCoverPct: 55, weatherCode: 2, isDay: true
  },
  {
    label: 'overcast drizzle',
    temperatureC: 11.4, precipitationMmH: 0.4, windSpeedKmh: 14, windDirectionDeg: 230,
    cloudCoverPct: 96, weatherCode: 53, isDay: true
  },
  {
    label: 'heavy rain, strong wind',
    temperatureC: 9.8, precipitationMmH: 7.5, windSpeedKmh: 48, windDirectionDeg: 265,
    cloudCoverPct: 100, weatherCode: 65, isDay: true
  },
  {
    label: 'thunderstorm at night',
    temperatureC: 16.2, precipitationMmH: 5.0, windSpeedKmh: 33, windDirectionDeg: 210,
    cloudCoverPct: 98, weatherCode: 95, isDay: false
  },
  {
    label: 'snow, calm',
    temperatureC: -2.5, precipitationMmH: 1.4, windSpeedKmh: 5, windDirectionDeg: 20,
    cloudCoverPct: 90, weatherCode: 73, isDay: true
  },
  {
    label: 'fog',
    temperatureC: 4.0, precipitationMmH: 0, windSpeedKmh: 2, windDirectionDeg: 100,
    cloudCoverPct: 100, weatherCode: 45, isDay: true
  },
  {
    label: 'clear night',
    temperatureC: 8.9, precipitationMmH: 0, windSpeedKmh: 9, windDirectionDeg: 180,
    cloudCoverPct: 8, weatherCode: 0, isDay: false
  },
  {
    // The case a viewer must be able to tell from "calm weather": the scene is
    // still animating, but the numbers are hours old.
    label: 'stale reading',
    temperatureC: 13.0, precipitationMmH: 0, windSpeedKmh: 11, windDirectionDeg: 190,
    cloudCoverPct: 40, weatherCode: 1, isDay: true,
    ageMs: 3 * 60 * 60 * 1000, stale: true
  }
]
