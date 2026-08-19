// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Launch flags that fake the capture state (#248).
 *
 * The app's two most interesting display states -- the split-flap no-signal
 * board and the 30-screensaver rotation -- are the two hardest to reach. Both
 * sit behind real hardware losing real signal, and the screensaver additionally
 * behind a five-minute delay. Before these flags the only honest way to see
 * either was to unplug a capture card and wait.
 *
 * Three flags, deliberately orthogonal:
 *
 *   --mock[=N]                synthetic inputs, no capture hardware needed
 *   --no-signal               force every input into the no-signal state
 *   --screensaver-delay=MS    override the five-minute wait
 *
 * `--no-signal` on its own is the fast path to the board on any machine, with
 * or without capture hardware. Combined with `--mock` you get named inputs to
 * switch between while they are all dark, which is what exercises the
 * per-side transitions rather than just the initial state.
 *
 * Parsing lives here, apart from both the main and renderer processes, because
 * it is the one part of this that is pure and therefore testable: main reads
 * process.argv, the renderer receives the result over IPC, and neither can be
 * unit tested. A mistyped flag on the wall is a wasted trip to the wall, so
 * unrecognised and malformed values are collected and reported rather than
 * silently dropped.
 */

/** Most inputs `--mock=N` will synthesise. */
export const MAX_MOCK_INPUTS = 8

/** Inputs `--mock` synthesises when no count is given: one per 1-4 shortcut. */
export const DEFAULT_MOCK_INPUTS = 4

/** Flag state for a normal production launch. */
export const DEFAULT_TEST_FLAGS = Object.freeze({
  mock: false,
  mockInputs: 0,
  noSignal: false,
  screensaverDelayMs: null,
})

/** Every flag this module understands, for the unrecognised-flag check. */
const KNOWN = ['--mock', '--no-signal', '--screensaver-delay']

/**
 * Parse an integer flag value, returning null when it is not a usable number.
 *
 * Rejects the empty string, which Number() maps to 0 -- `--mock=` should be an
 * error, not a request for zero inputs.
 */
function parseIntValue(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return n
}

/**
 * Read the test flags out of an argv array.
 *
 * Scans for known flags anywhere in argv rather than parsing positionally: the
 * same flags have to survive `electron .`, `electron-vite dev`, a packaged
 * .app launched by open(1), and electron-builder's own inserted arguments, and
 * none of those agree on where the user's arguments start.
 *
 * @param {string[]} argv
 * @returns {{flags: object, errors: string[]}} flags is always complete;
 *   errors is empty on a clean parse and is meant to be logged, not thrown --
 *   a typo should not stop the app from starting.
 */
export function parseTestFlags(argv) {
  const flags = { ...DEFAULT_TEST_FLAGS }
  const errors = []
  const args = Array.isArray(argv) ? argv : []

  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue

    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const value = eq === -1 ? null : arg.slice(eq + 1)

    if (!KNOWN.includes(name)) {
      // Only flags that look like ours are worth complaining about. Electron
      // and Chromium pass plenty of their own (--inspect, --enable-features,
      // --remote-debugging-port), and reporting those as typos would make the
      // report useless.
      if (/^--(mock|no.?signal|screensaver)/i.test(name)) {
        errors.push(`unrecognised flag: ${name}`)
      }
      continue
    }

    switch (name) {
      case '--mock': {
        flags.mock = true
        if (value === null) {
          flags.mockInputs = DEFAULT_MOCK_INPUTS
          break
        }
        const n = parseIntValue(value)
        if (n === null || n < 1 || n > MAX_MOCK_INPUTS) {
          errors.push(
            `--mock expects 1-${MAX_MOCK_INPUTS} inputs, got "${value}"; ` +
            `using ${DEFAULT_MOCK_INPUTS}`)
          flags.mockInputs = DEFAULT_MOCK_INPUTS
        } else {
          flags.mockInputs = n
        }
        break
      }

      case '--no-signal':
        if (value !== null) {
          errors.push(`--no-signal takes no value, ignoring "=${value}"`)
        }
        flags.noSignal = true
        break

      case '--screensaver-delay': {
        const n = parseIntValue(value)
        if (n === null || n < 0) {
          errors.push(
            `--screensaver-delay expects milliseconds >= 0, got ` +
            `"${value === null ? '' : value}"; keeping the default`)
          break
        }
        flags.screensaverDelayMs = n
        break
      }
    }
  }

  return { flags, errors }
}

/** Is any flag set? Used to decide whether to announce test mode at all. */
export function anyTestFlagSet(flags) {
  return Boolean(flags.mock || flags.noSignal || flags.screensaverDelayMs !== null)
}

/** One-line summary for the startup log, so a wall never lies about its mode. */
export function describeTestFlags(flags) {
  const parts = []
  if (flags.mock) parts.push(`mock inputs: ${flags.mockInputs}`)
  if (flags.noSignal) parts.push('no-signal forced')
  if (flags.screensaverDelayMs !== null) {
    parts.push(`screensaver delay: ${flags.screensaverDelayMs}ms`)
  }
  return parts.join(', ')
}
