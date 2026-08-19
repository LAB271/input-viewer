// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Launch flag parsing (#248).
 *
 * Worth testing properly despite being small, because it is the only part of
 * the feature that CAN be tested off a wall: main reads process.argv and the
 * renderer applies the result, and neither is reachable from vitest. If a flag
 * is going to be wrong, this is where it gets caught.
 *
 * The error cases matter as much as the happy ones. A flag that silently does
 * nothing means someone at the videowall is looking at a production-mode screen
 * believing it is in test mode, which is worse than a crash.
 */
import { describe, it, expect } from 'vitest'
import {
  parseTestFlags,
  anyTestFlagSet,
  describeTestFlags,
  DEFAULT_TEST_FLAGS,
  DEFAULT_MOCK_INPUTS,
  MAX_MOCK_INPUTS,
} from '../src/renderer/test-flags.js'

describe('a production launch', () => {
  it('sets no flags for an empty argv', () => {
    const { flags, errors } = parseTestFlags([])
    expect(flags).toEqual(DEFAULT_TEST_FLAGS)
    expect(errors).toEqual([])
    expect(anyTestFlagSet(flags)).toBe(false)
  })

  it('ignores the arguments Electron and Chromium pass', () => {
    // These arrive on real launches. Reporting them as typos would bury any
    // genuine one in noise, which is the only reason the errors list is useful.
    const { flags, errors } = parseTestFlags([
      '/Applications/Input Viewer.app/Contents/MacOS/Input Viewer',
      '--enable-features=SharedArrayBuffer',
      '--remote-debugging-port=9222',
      '--inspect',
      '--user-data-dir=/tmp/x',
    ])
    expect(flags).toEqual(DEFAULT_TEST_FLAGS)
    expect(errors).toEqual([])
  })

  it('survives a missing or malformed argv rather than throwing', () => {
    // main forwards whatever IPC gives it; a null must not stop the app booting.
    for (const argv of [null, undefined, 'not-an-array', [null, 42, {}]]) {
      const { flags, errors } = parseTestFlags(argv)
      expect(flags).toEqual(DEFAULT_TEST_FLAGS)
      expect(errors).toEqual([])
    }
  })
})

describe('--mock', () => {
  it('defaults to one input per 1-4 shortcut', () => {
    const { flags, errors } = parseTestFlags(['--mock'])
    expect(flags.mock).toBe(true)
    expect(flags.mockInputs).toBe(DEFAULT_MOCK_INPUTS)
    expect(errors).toEqual([])
  })

  it('takes an explicit count', () => {
    expect(parseTestFlags(['--mock=1']).flags.mockInputs).toBe(1)
    expect(parseTestFlags(['--mock=2']).flags.mockInputs).toBe(2)
    expect(parseTestFlags([`--mock=${MAX_MOCK_INPUTS}`]).flags.mockInputs)
      .toBe(MAX_MOCK_INPUTS)
  })

  it('still enables mock mode when the count is unusable, and says so', () => {
    // Falling back rather than refusing: the operator clearly asked for mock
    // mode, and starting in production mode because the count was fat-fingered
    // would be the least useful reading of the request.
    for (const bad of ['0', '-1', '99', 'four', '', '2.5', 'NaN']) {
      const { flags, errors } = parseTestFlags([`--mock=${bad}`])
      expect(flags.mock).toBe(true)
      expect(flags.mockInputs).toBe(DEFAULT_MOCK_INPUTS)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/--mock expects/)
    }
  })

  it('reports a near-miss spelling instead of ignoring it', () => {
    const { flags, errors } = parseTestFlags(['--mocks'])
    expect(flags.mock).toBe(false)
    expect(errors).toEqual(['unrecognised flag: --mocks'])
  })
})

describe('--no-signal', () => {
  it('is a bare boolean', () => {
    const { flags, errors } = parseTestFlags(['--no-signal'])
    expect(flags.noSignal).toBe(true)
    expect(errors).toEqual([])
  })

  it('sets the flag but complains when given a value', () => {
    // --no-signal=false reads as "off" and would silently mean "on"; the flag
    // is still honoured, but the log says why it may not be what was meant.
    const { flags, errors } = parseTestFlags(['--no-signal=false'])
    expect(flags.noSignal).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/takes no value/)
  })

  it('reports the hyphenless spelling', () => {
    const { flags, errors } = parseTestFlags(['--nosignal'])
    expect(flags.noSignal).toBe(false)
    expect(errors).toEqual(['unrecognised flag: --nosignal'])
  })
})

describe('--screensaver-delay', () => {
  it('takes milliseconds', () => {
    expect(parseTestFlags(['--screensaver-delay=5000']).flags.screensaverDelayMs)
      .toBe(5000)
  })

  it('accepts zero, meaning start as soon as the state is reached', () => {
    const { flags, errors } = parseTestFlags(['--screensaver-delay=0'])
    expect(flags.screensaverDelayMs).toBe(0)
    expect(errors).toEqual([])
    // Zero is a real value, not an absent one -- null is what "unset" means.
    expect(anyTestFlagSet(flags)).toBe(true)
  })

  it('keeps the production delay when the value is unusable, and says so', () => {
    for (const bad of ['--screensaver-delay', '--screensaver-delay=',
      '--screensaver-delay=-1', '--screensaver-delay=soon']) {
      const { flags, errors } = parseTestFlags([bad])
      expect(flags.screensaverDelayMs).toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/expects milliseconds/)
    }
  })
})

describe('flags in combination', () => {
  it('parses the three together, in any position', () => {
    const { flags, errors } = parseTestFlags([
      '/path/to/electron', '--enable-logging', '--no-signal',
      '.', '--mock=2', '--screensaver-delay=1500',
    ])
    expect(flags).toEqual({
      mock: true, mockInputs: 2, noSignal: true, screensaverDelayMs: 1500,
    })
    expect(errors).toEqual([])
  })

  it('lets a later occurrence win', () => {
    expect(parseTestFlags(['--mock=2', '--mock=3']).flags.mockInputs).toBe(3)
  })

  it('describes what it parsed, for the startup log', () => {
    const { flags } = parseTestFlags(['--mock=2', '--no-signal',
      '--screensaver-delay=0'])
    const text = describeTestFlags(flags)
    expect(text).toContain('mock inputs: 2')
    expect(text).toContain('no-signal forced')
    expect(text).toContain('screensaver delay: 0ms')
  })

  it('describes nothing when nothing is set', () => {
    expect(describeTestFlags(DEFAULT_TEST_FLAGS)).toBe('')
  })
})
