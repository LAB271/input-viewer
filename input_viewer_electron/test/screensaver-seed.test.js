// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRng, seedFromString, seedFromClock, randomPalettePhase } from '../src/renderer/screensavers/seed.js'
import { SCREENSAVERS, pickRandomIndex } from '../src/renderer/screensavers/registry.js'
import { __injectReading } from '../src/renderer/screensavers/weather-source.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAVER_DIR = join(HERE, '..', 'src', 'renderer', 'screensavers')

describe('seedFromString', () => {
  it('is deterministic', () => {
    expect(seedFromString('hello')).toBe(seedFromString('hello'))
  })

  it('returns a 32-bit unsigned integer', () => {
    for (const s of ['', 'a', 'the quick brown fox', '1755000000000']) {
      const h = seedFromString(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('decorrelates adjacent millisecond timestamps', () => {
    // The reason seedFromClock hashes the timestamp instead of using it raw:
    // consecutive activations differ only in the low bits, and an LCG seeded
    // with near-identical values produces correlated streams.
    const a = createRng(seedFromString('1755000000000'))
    const b = createRng(seedFromString('1755000000001'))
    const first = [a.next(), a.next(), a.next()]
    const second = [b.next(), b.next(), b.next()]
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(first[i] - second[i])).toBeGreaterThan(0.01)
    }
  })
})

describe('seedFromClock', () => {
  it('produces a valid 32-bit seed', () => {
    const s = seedFromClock()
    expect(Number.isInteger(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('createRng', () => {
  it('is reproducible from the same seed', () => {
    const a = createRng(12345)
    const b = createRng(12345)
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next())
  })

  it('accepts a string seed', () => {
    const a = createRng('wall-2026-08-05')
    const b = createRng('wall-2026-08-05')
    expect(a.next()).toBe(b.next())
    expect(createRng('other').next()).not.toBe(createRng('wall-2026-08-05').next())
  })

  it('reports the resolved seed so a run can be reproduced', () => {
    expect(createRng(999).seed).toBe(999)
    expect(createRng('abc').seed).toBe(seedFromString('abc'))
    // An omitted seed still resolves to something concrete and loggable.
    expect(typeof createRng().seed).toBe('number')
  })

  it('yields values in [0,1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 5000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is roughly uniform', () => {
    // 10 buckets over 20k draws: expected 2000 each. A generator with visible
    // structure (the fract(sin(x)) family) fails this kind of check.
    const rng = createRng(4242)
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 20000; i++) buckets[Math.floor(rng.next() * 10)]++
    for (const b of buckets) {
      expect(b).toBeGreaterThan(1700)
      expect(b).toBeLessThan(2300)
    }
  })

  it('range() and around() stay in bounds', () => {
    const rng = createRng(1)
    for (let i = 0; i < 2000; i++) {
      const r = rng.range(-3, 5)
      expect(r).toBeGreaterThanOrEqual(-3)
      expect(r).toBeLessThan(5)
      const a = rng.around(10, 2)
      expect(a).toBeGreaterThanOrEqual(8)
      expect(a).toBeLessThan(12)
    }
  })

  it('int() covers its inclusive range', () => {
    const rng = createRng(2)
    const seen = new Set()
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(3, 7)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      seen.add(v)
    }
    expect(seen.size).toBe(5)
  })

  it('pick() only returns members', () => {
    const rng = createRng(3)
    const items = ['a', 'b', 'c']
    const seen = new Set()
    for (let i = 0; i < 500; i++) {
      const v = rng.pick(items)
      expect(items).toContain(v)
      seen.add(v)
    }
    expect(seen.size).toBe(3)
  })

  it('sign() returns only +1/-1, both of them', () => {
    const rng = createRng(5)
    const seen = new Set()
    for (let i = 0; i < 200; i++) {
      const v = rng.sign()
      expect([1, -1]).toContain(v)
      seen.add(v)
    }
    expect(seen.size).toBe(2)
  })

  it('phase() and angle() span a full turn', () => {
    const rng = createRng(6)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 2000; i++) {
      const p = rng.phase()
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(Math.PI * 2)
      min = Math.min(min, p)
      max = Math.max(max, p)
    }
    expect(min).toBeLessThan(0.2)
    expect(max).toBeGreaterThan(Math.PI * 2 - 0.2)
  })

  it('chance() respects its probability', () => {
    const rng = createRng(8)
    let hits = 0
    for (let i = 0; i < 10000; i++) if (rng.chance(0.25)) hits++
    expect(hits).toBeGreaterThan(2200)
    expect(hits).toBeLessThan(2800)
  })
})

describe('randomPalettePhase', () => {
  it('keeps the three offsets separated around the colour wheel', () => {
    // Three independent uniforms would frequently land close together, which
    // collapses a cosine palette to near-greyscale. The spread is the point.
    for (let s = 0; s < 200; s++) {
      const [a, b, c] = randomPalettePhase(createRng(s))
      const sep = (x, y) => {
        const d = Math.abs((x - y) % 1)
        return Math.min(d, 1 - d)
      }
      expect(sep(a, b)).toBeGreaterThan(0.15)
      expect(sep(b, c)).toBeGreaterThan(0.15)
      expect(sep(a, c)).toBeGreaterThan(0.15)
    }
  })

  it('varies between seeds', () => {
    expect(randomPalettePhase(createRng(1))[0]).not.toBe(randomPalettePhase(createRng(2))[0])
  })
})

describe('pickRandomIndex', () => {
  // The weather saver declines to be picked until a reading exists (#101), and
  // in the node environment there is never one. These cases are about the
  // draw itself, so pin a reading to make the whole set available; availability
  // has its own describe below.
  beforeEach(() => {
    __injectReading({
      temperatureC: 12, precipitationMmH: 0, windSpeedKmh: 5, windDirectionDeg: 0,
      cloudCoverPct: 50, weatherCode: 1, isDay: true
    })
  })
  afterEach(() => __injectReading(null))

  it('never returns the avoided index', () => {
    for (let avoid = 0; avoid < SCREENSAVERS.length; avoid++) {
      for (let i = 0; i < 200; i++) {
        // Sweep rand() across [0,1) rather than trusting a single draw.
        const r = () => i / 200
        expect(pickRandomIndex(avoid, r)).not.toBe(avoid)
      }
    }
  })

  it('stays in range and can reach every index', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) {
      const idx = pickRandomIndex(-1, () => i / 1000)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(SCREENSAVERS.length)
      seen.add(idx)
    }
    expect(seen.size).toBe(SCREENSAVERS.length)
  })

  it('reaches every index except the avoided one', () => {
    const avoid = 4
    const seen = new Set()
    for (let i = 0; i < 2000; i++) seen.add(pickRandomIndex(avoid, () => i / 2000))
    expect(seen.size).toBe(SCREENSAVERS.length - 1)
    expect(seen.has(avoid)).toBe(false)
  })

  it('handles rand() returning values at the very top of [0,1)', () => {
    // Math.random() can return 0.9999...; an off-by-one here would index
    // past the end of the array and start `undefined`.
    expect(pickRandomIndex(-1, () => 0.9999999)).toBe(SCREENSAVERS.length - 1)
    expect(pickRandomIndex(0, () => 0.9999999)).toBe(SCREENSAVERS.length - 1)
  })
})

// =============================================================================
// GLSL sanity checks.
//
// No shader is ever compiled in CI (there is no WebGL2 context in the node
// test environment, and headless-gl would mean a native build dependency).
// These checks catch the class of error that is otherwise invisible until the
// screensaver is run by hand: a stray non-numeric token in a coordinate
// literal, an unbalanced brace, or an iSeed reference in a saver that never
// declares the uniform. All three were hit while writing the seed work.
// =============================================================================

const SHADER_SAVERS = [
  'plasma.js', 'flow-field.js', 'raymarch.js',
  'mandelbrot.js', 'julia.js', 'burning-ship.js'
]

const readSaver = (f) => readFileSync(join(SAVER_DIR, f), 'utf8')

// Extract the contents of every glsl-tagged template literal in a module.
function glslBlocks(src) {
  const blocks = []
  const re = /\/\* glsl \*\/\s*`/g
  let m
  while ((m = re.exec(src)) !== null) {
    // Walk to the matching unescaped backtick.
    let i = m.index + m[0].length
    let out = ''
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue }
      out += src[i]
      i++
    }
    blocks.push(out)
  }
  return blocks
}

describe('GLSL shader sources', () => {
  it('every shader saver has an extractable glsl block', () => {
    for (const f of SHADER_SAVERS) {
      expect(glslBlocks(readSaver(f)).length, f).toBeGreaterThan(0)
    }
  })

  it('float literals contain no stray identifier characters', () => {
    // Catches `-1.7croix` / `0.01432abc89`: a number immediately followed by
    // letters. GLSL has no numeric suffixes in ES 3.00, so any letter glued to
    // a digit sequence is a typo. `1.0e-3` and `0x1F` are legitimate, so the
    // exponent and hex forms are excluded.
    const bad = /\b\d+\.?\d*(?!\s*[eE][-+]?\d)[A-Za-z_][A-Za-z0-9_]*/g
    for (const f of SHADER_SAVERS) {
      for (const block of glslBlocks(readSaver(f))) {
        const stripped = block
          .replace(/\/\/[^\n]*/g, '')          // line comments ("2D curl of...")
          .replace(/\/\*[\s\S]*?\*\//g, '')    // block comments
          .replace(/0[xX][0-9a-fA-F]+/g, '')   // hex literals
        const hits = stripped.match(bad) || []
        expect(hits, `${f}: malformed numeric literal(s)`).toEqual([])
      }
    }
  })

  it('braces and parens are balanced', () => {
    for (const f of SHADER_SAVERS) {
      for (const block of glslBlocks(readSaver(f))) {
        const code = block.replace(/\/\/[^\n]*/g, '')
        const count = (ch) => (code.split(ch).length - 1)
        expect(count('{'), `${f}: brace mismatch`).toBe(count('}'))
        expect(count('('), `${f}: paren mismatch`).toBe(count(')'))
      }
    }
  })

  it('declares iSeed usage against the header gl-base.js provides', () => {
    // FRAGMENT_HEADER declares iSeed for every createShaderScreensaver saver,
    // so using it needs no local declaration -- but a saver that declares its
    // own would be a duplicate-definition compile error.
    const header = readSaver('gl-base.js')
    expect(header).toMatch(/uniform vec4 iSeed;/)
    for (const f of SHADER_SAVERS) {
      const src = readSaver(f)
      for (const block of glslBlocks(src)) {
        // A saver that drives its own loop (raymarch accumulates temporally, so
        // it cannot use createShaderScreensaver) supplies the whole shader
        // itself and therefore MUST declare iSeed. Those blocks carry their own
        // #version line; the ones spliced onto FRAGMENT_HEADER never do.
        if (/#version/.test(block)) continue
        expect(block, `${f} must not redeclare iSeed`).not.toMatch(/uniform\s+vec4\s+iSeed/)
      }
    }
  })

  it('every shader saver actually uses iSeed', () => {
    // The whole point of this work: none of these may be a pure function of
    // (resolution, iTime, iFrame) any more, or it replays identically.
    for (const f of SHADER_SAVERS) {
      const glsl = glslBlocks(readSaver(f)).join('\n')
      expect(glsl, `${f} does not vary per activation`).toMatch(/iSeed/)
    }
  })

  it('only references iSeed components that exist', () => {
    for (const f of SHADER_SAVERS) {
      const glsl = glslBlocks(readSaver(f)).join('\n')
      const refs = glsl.match(/iSeed\.[a-z]+/g) || []
      for (const r of refs) {
        expect(r, `${f}: ${r} is not a valid vec4 swizzle`).toMatch(/^iSeed\.[xyzw]{1,4}$/)
      }
    }
  })
})

describe('reaction-diffusion regimes', () => {
  // Gray-Scott has a non-trivial steady state only where k < sqrt(f)/2 - f.
  // Outside it, B decays to zero and the screensaver fades to flat background.
  // Parsed from source rather than exported, so the constants stay private.
  const parseRegimes = () => {
    const src = readSaver('reaction-diffusion.js')
    const block = src.slice(src.indexOf('const REGIMES'), src.indexOf(']', src.indexOf('const REGIMES')))
    const re = /feed:\s*([\d.]+),\s*kill:\s*([\d.]+),\s*name:\s*'([^']+)'/g
    const out = []
    let m
    while ((m = re.exec(block)) !== null) {
      out.push({ feed: Number(m[1]), kill: Number(m[2]), name: m[3] })
    }
    return out
  }

  it('parses the regime table', () => {
    expect(parseRegimes().length).toBeGreaterThanOrEqual(4)
  })

  it('every regime admits a non-trivial pattern', () => {
    for (const r of parseRegimes()) {
      const bound = Math.sqrt(r.feed) / 2 - r.feed
      expect(r.kill, `regime "${r.name}" (f=${r.feed}, k=${r.kill}) needs k < ${bound.toFixed(4)}`)
        .toBeLessThan(bound)
    }
  })

  it('keeps feed and kill in the physically sensible range', () => {
    for (const r of parseRegimes()) {
      expect(r.feed, r.name).toBeGreaterThan(0)
      expect(r.feed, r.name).toBeLessThan(0.1)
      expect(r.kill, r.name).toBeGreaterThan(0)
      expect(r.kill, r.name).toBeLessThan(0.08)
    }
  })
})

describe('screensaver module contract', () => {
  it('every registered saver exposes name and create()', () => {
    for (const s of SCREENSAVERS) {
      expect(typeof s.name).toBe('string')
      expect(s.name.length).toBeGreaterThan(0)
      expect(typeof s.create).toBe('function')
    }
  })

  it('every saver module in the folder is registered', () => {
    // A saver that exists but is not in SCREENSAVERS silently never runs.
    const infra = new Set([
      'gl-base.js', 'glsl-lib.js', 'post-fx.js', 'registry.js', 'seed.js',
      'glyph-atlas.js',
      // Generated data for the shadercheck structure check (#156), not a saver.
      'structure-baselines.js',
      // The weather poller (#101). Lives here because only the weather saver
      // reads it, but it is infrastructure: it owns a network poll and a timer,
      // has no canvas and no create(), and runs on the app's lifecycle rather
      // than an activation's.
      'weather-source.js',
      // Art-Net reactive mode (#59): posts the active saver's dominant colour to
      // the lighting relay. Infrastructure, not a saver -- no canvas, no
      // create(), and its lifetime is the app's rather than an activation's.
      'artnet-sync.js',
      // Canned readings for reviewing the weather saver (#101). Preview and
      // tests only; nothing in the shipped app reads it.
      'weather-states.js',
      // The no-signal display, not a rotating screensaver (#92): it is driven
      // directly by renderer.js when a feed loses signal, so it is deliberately
      // absent from SCREENSAVERS.
      'split-flap.js',
      'preview.js', 'preview.html',
      'shadercheck.js', 'shadercheck.html'
    ])
    const modules = readdirSync(SAVER_DIR)
      .filter((f) => f.endsWith('.js') && !infra.has(f))
    expect(modules.length).toBe(SCREENSAVERS.length)
  })

  it('create() accepts a seed argument', () => {
    // Arity is the only thing checkable without a GL context, but it catches a
    // saver whose create() was never updated to thread the seed through.
    for (const s of SCREENSAVERS) {
      expect(s.create.length, `${s.name}.create() should take (canvas, seed)`).toBeGreaterThanOrEqual(2)
    }
  })
})
