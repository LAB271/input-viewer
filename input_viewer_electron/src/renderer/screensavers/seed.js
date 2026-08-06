// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Per-activation randomness for screensavers, seeded from the wall clock.
 *
 * The problem this solves: every screensaver was a pure function of
 * (resolution, iTime, iFrame), and gl-base.js resets iTime and iFrame to 0 on
 * every start(). Seven of the twelve savers had no randomness at all, so each
 * activation replayed bit-for-bit -- the same Mandelbrot wide shot zooming to
 * the same coordinate, the same raymarch camera azimuth, the same Julia shape.
 *
 * Why the wall clock rather than Math.random(): a date/time seed is
 * *reproducible*. Note the timestamp of a look you liked and you can get it
 * back (see seedFromString / the preview harness's ?seed= parameter), which
 * matters both for debugging a bad-looking run and for pinning a frame while
 * tuning constants. Math.random() gives variety you can never recover.
 *
 * The generator is a plain 32-bit LCG-style hash chain (mulberry32). It is not
 * cryptographic and does not need to be -- it needs to be fast, dependency
 * free, deterministic given a seed, and well-distributed enough that two
 * activations one second apart look unrelated. Mulberry32 passes the last
 * point comfortably; the avalanche in its mixing step means adjacent seeds
 * produce unrelated streams, which a naive `seed * 9301 + 49297` would not.
 */

/**
 * Mulberry32: 32-bit seed in, uniform [0,1) stream out.
 *
 * @param {number} seed - any 32-bit integer
 * @returns {() => number} next() yielding [0,1)
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Hash an arbitrary string to a 32-bit integer (FNV-1a).
 *
 * Used so a seed can be given as a human-readable string -- the preview
 * harness accepts `?seed=anything`, which is far easier to type and share
 * than a 10-digit integer.
 *
 * @param {string} str
 * @returns {number} 32-bit unsigned
 */
export function seedFromString(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Seed value for the current moment.
 *
 * Date.now() is milliseconds, so consecutive activations differ; the low bits
 * carry the entropy and mulberry32's mixing spreads them across the stream.
 * Passed through the string hasher rather than used raw because the raw value
 * is a large near-constant (its high bits barely move between activations),
 * and seeding an LCG with near-identical values is exactly the case where
 * correlated streams show up.
 *
 * @returns {number} 32-bit unsigned
 */
export function seedFromClock() {
  return seedFromString(String(Date.now()))
}

/**
 * Create a seeded random source for one screensaver activation.
 *
 * The returned object is deliberately richer than a bare next() because the
 * call sites want *ranges and choices*, not raw floats -- writing
 * `rng.range(-1.4, -1.0)` at a call site reads as intent, while
 * `-1.4 + rng() * 0.4` reads as arithmetic and is easy to get subtly wrong.
 *
 * @param {number|string} [seed] - omit for a clock seed
 * @returns {object} rng
 */
export function createRng(seed) {
  const resolved = seed === undefined || seed === null
    ? seedFromClock()
    : (typeof seed === 'string' ? seedFromString(seed) : seed >>> 0)

  const next = mulberry32(resolved)

  return {
    /** The 32-bit seed actually used. Logged so a run can be reproduced. */
    seed: resolved,

    /** @returns {number} uniform in [0,1) */
    next,

    /**
     * @param {number} min
     * @param {number} max
     * @returns {number} uniform in [min,max)
     */
    range(min, max) {
      return min + next() * (max - min)
    },

    /**
     * Uniform in [center-spread, center+spread). Reads better than range()
     * when a constant is being perturbed rather than chosen outright.
     * @param {number} center
     * @param {number} spread
     * @returns {number}
     */
    around(center, spread) {
      return center + (next() * 2 - 1) * spread
    },

    /**
     * @param {number} min
     * @param {number} maxInclusive
     * @returns {number} integer in [min,maxInclusive]
     */
    int(min, maxInclusive) {
      return min + Math.floor(next() * (maxInclusive - min + 1))
    },

    /**
     * @template T
     * @param {T[]} items
     * @returns {T} one item, uniformly
     */
    pick(items) {
      return items[Math.floor(next() * items.length)]
    },

    /**
     * @param {number} [p=0.5] probability of true
     * @returns {boolean}
     */
    chance(p = 0.5) {
      return next() < p
    },

    /** @returns {number} +1 or -1 */
    sign() {
      return next() < 0.5 ? -1 : 1
    },

    /** @returns {number} uniform angle in [0, 2pi) */
    angle() {
      return next() * Math.PI * 2
    },

    /**
     * A random phase offset, in the same units the savers use for their
     * time-driven sinusoids. Almost every saver's replay problem is that its
     * sin/cos terms all start at phase 0; adding one of these to each is the
     * minimal fix, so it gets a dedicated name.
     * @returns {number} uniform in [0, 2pi)
     */
    phase() {
      return next() * Math.PI * 2
    }
  }
}

/**
 * A cosine-palette phase triple, as used by nearly every saver's
 * `0.5 + 0.5*cos(6.2831*(t + PHASE))` colouring.
 *
 * Constrained rather than fully random: three independent uniforms frequently
 * land close together, which collapses the palette to near-greyscale. Keeping
 * the offsets spread around the colour wheel (a random rotation plus jittered
 * thirds) guarantees a palette with actual hue separation while still varying
 * per activation.
 *
 * @param {object} rng
 * @returns {[number, number, number]}
 */
export function randomPalettePhase(rng) {
  const rot = rng.next()
  const jitter = 0.06
  return [
    rot + rng.around(0, jitter),
    rot + 0.33 + rng.around(0, jitter),
    rot + 0.67 + rng.around(0, jitter)
  ]
}
