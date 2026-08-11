// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Screensaver registry.
 *
 * Holds the list of available screensavers and drives a single active one
 * against a shared <canvas>. A new random screensaver is chosen on each
 * activation (start), so the no-signal screen varies over time.
 *
 * Each screensaver module is an object:
 *   { name: string, create(canvas, seed) -> { start(), stop() } }
 *
 * `seed` is optional and, when omitted, each saver seeds itself from the wall
 * clock (see seed.js). It is threaded through so the preview harness can pin a
 * seed and reproduce a specific look; production always passes undefined.
 *
 * To add a screensaver: drop a module in this folder and add it to the
 * SCREENSAVERS array below. Pure fragment-shader ones can use
 * createShaderScreensaver from gl-base.js.
 */
import { seedFromClock } from './seed.js'
import dvdLogo from './dvd-logo.js'
import plasma from './plasma.js'
import flowField from './flow-field.js'
import raymarch from './raymarch.js'
import mandelbrot from './mandelbrot.js'
import julia from './julia.js'
import burningShip from './burning-ship.js'
import reactionDiffusion from './reaction-diffusion.js'
import particleSwarm from './particle-swarm.js'
import whiteParticles from './white-particles.js'
import boids from './boids.js'
import strangeAttractor from './strange-attractor.js'
import voronoi from './voronoi.js'
import metaballs from './metaballs.js'
import gameOfLife from './game-of-life.js'
import matrixRain from './matrix-rain.js'
import starfield from './starfield.js'
import pong from './pong.js'
import truchet from './truchet.js'
import moire from './moire.js'
import asciiDonut from './ascii-donut.js'
import doublePendulum from './double-pendulum.js'
import waveTank from './wave-tank.js'
import fallingSand from './falling-sand.js'
import frost from './frost.js'
import treeGrowth from './tree-growth.js'
import physarum from './physarum.js'
import aquarium from './aquarium.js'
import bicycleHorizon from './bicycle-horizon.js'
import weather from './weather.js'

export const SCREENSAVERS = [
  dvdLogo,
  plasma,
  flowField,
  raymarch,
  mandelbrot,
  julia,
  burningShip,
  reactionDiffusion,
  particleSwarm,
  whiteParticles,
  boids,
  strangeAttractor,
  voronoi,
  metaballs,
  gameOfLife,
  matrixRain,
  starfield,
  pong,
  truchet,
  moire,
  asciiDonut,
  doublePendulum,
  waveTank,
  fallingSand,
  frost,
  treeGrowth,
  physarum,
  aquarium,
  bicycleHorizon,
  weather
]

let canvasEl = null
let active = null          // the running instance { start, stop }
let activeIndex = -1
let running = false
// Survives stopScreensaver() so a random pick can avoid an immediate repeat.
// Without this, a rotation has a 1-in-12 chance of "rotating" to the same
// saver, which reads as the rotation being broken.
let lastIndex = -1

/**
 * Bind the registry to a canvas element. Call once at init.
 * @param {HTMLCanvasElement} canvas
 */
export function initScreensavers(canvas) {
  canvasEl = canvas
}

/** @returns {string[]} names of all registered screensavers */
export function listScreensavers() {
  return SCREENSAVERS.map((s) => s.name)
}

/**
 * Whether a saver is willing to be chosen right now.
 *
 * Optional part of the module contract (issue #101): a saver that depends on
 * something outside itself can decline until it has what it needs. Only the
 * weather saver uses it, and only until a reading is cached; every other module
 * omits it and is always available.
 *
 * This exists so `startScreensaver` can stay **synchronous**. The alternative
 * considered was an async `prepare()` the registry awaits, which would have made
 * this function async for every caller -- renderer.js, preview.js,
 * shadercheck.js, the stepping shortcuts -- and put an HTTP round trip in front
 * of the first no-signal event.
 *
 * A throwing isAvailable() counts as unavailable rather than propagating: this
 * runs on the no-signal path, where showing *a* screensaver matters more than
 * surfacing a predicate's bug.
 *
 * @param {object} saver
 * @returns {boolean}
 */
function isAvailable(saver) {
  if (!saver || typeof saver.isAvailable !== 'function') return true
  try {
    return saver.isAvailable() !== false
  } catch (err) {
    console.error(`[Screensaver] isAvailable() threw for "${saver.name}":`, err)
    return false
  }
}

/** @returns {number[]} indices of savers currently willing to be chosen */
function availableIndices() {
  const idx = []
  for (let i = 0; i < SCREENSAVERS.length; i++) {
    if (isAvailable(SCREENSAVERS[i])) idx.push(i)
  }
  return idx
}

/**
 * Pick a random index, avoiding the previous one and skipping any saver that is
 * currently unavailable.
 *
 * Exported for the test suite; also used for the 'random' selector and as the
 * fallback when a name doesn't match.
 *
 * @param {number} [avoid] index to skip, or -1/undefined for none
 * @param {() => number} [rand] injectable for tests
 * @returns {number}
 */
export function pickRandomIndex(avoid = -1, rand = Math.random) {
  const n = SCREENSAVERS.length
  if (n <= 1) return 0

  // Candidates: available, and not the previous pick. If filtering leaves
  // nothing -- every saver unavailable, or the only available one is `avoid` --
  // fall back to ignoring availability rather than returning nothing. A wall
  // showing the same saver twice is a much smaller problem than a blank one.
  const available = availableIndices()
  const candidates = available.filter((i) => i !== avoid)
  const pool = candidates.length ? candidates : (available.length ? available : null)
  if (pool) return pool[Math.floor(rand() * pool.length)]

  // Draw from the n-1 candidates that aren't `avoid`, then shift past it.
  // Cheaper and (unlike a retry loop) guaranteed to terminate.
  const span = avoid >= 0 && avoid < n ? n - 1 : n
  let idx = Math.floor(rand() * span)
  if (avoid >= 0 && avoid < n && idx >= avoid) idx += 1
  return idx
}

/**
 * Resolve a selector (index, name, or undefined=random) to an index.
 *
 * Availability (#101) gates the **random** rotation only. An explicit index or
 * name is honoured even for an unavailable saver, because the callers that pass
 * one are the preview harness and the stepping shortcuts, where the point is to
 * look at a specific saver -- silently substituting a different one there would
 * be baffling. A saver that can be unavailable therefore still has to render
 * something defensible without its data.
 *
 * @param {number|string|undefined} selector
 * @returns {number}
 */
function resolveIndex(selector) {
  if (selector === undefined || selector === null || selector === 'random') {
    return pickRandomIndex(lastIndex)
  }
  if (typeof selector === 'number') {
    return ((selector % SCREENSAVERS.length) + SCREENSAVERS.length) % SCREENSAVERS.length
  }
  // String name (case-insensitive, ignore spaces).
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')
  const idx = SCREENSAVERS.findIndex((s) => norm(s.name) === norm(selector))
  return idx >= 0 ? idx : pickRandomIndex(lastIndex)
}

/**
 * Start a screensaver on the bound canvas.
 * @param {number|string} [selector] - index, name, or omit for random
 * @param {number|string} [seed] - pin the look; omit for a wall-clock seed
 * @returns {string} the name of the screensaver that started
 */
export function startScreensaver(selector, seed) {
  if (!canvasEl) throw new Error('initScreensavers(canvas) must be called first')
  if (running) stopScreensaver()

  activeIndex = resolveIndex(selector)
  lastIndex = activeIndex
  const saver = SCREENSAVERS[activeIndex]
  // Resolve the seed here rather than letting each saver default it, so the
  // value can be logged -- reproducing a look means knowing what to pass back.
  const resolvedSeed = seed === undefined || seed === null ? seedFromClock() : seed
  try {
    active = saver.create(canvasEl, resolvedSeed)
    active.start()
    running = true
    console.log(`[Screensaver] Started: ${saver.name} (seed ${resolvedSeed})`)
  } catch (err) {
    console.error(`[Screensaver] Failed to start "${saver.name}":`, err)
    // A partially-started saver may hold GL resources; release them before
    // handing the same canvas to the fallback.
    if (active) {
      try { active.stop() } catch { /* the failed start is already logged */ }
      active = null
    }
    // Fall back to the DVD logo if a fancy one fails (e.g. shader error).
    if (saver !== SCREENSAVERS[0]) {
      activeIndex = 0
      lastIndex = 0
      active = SCREENSAVERS[0].create(canvasEl, resolvedSeed)
      active.start()
      running = true
      console.log('[Screensaver] Fell back to DVD Logo')
    }
  }
  return SCREENSAVERS[activeIndex]?.name
}

/** Stop the active screensaver. */
export function stopScreensaver() {
  if (active) {
    try { active.stop() } catch (err) { console.error('[Screensaver] stop error:', err) }
    active = null
  }
  running = false
  activeIndex = -1
}

/** @returns {boolean} */
export function isScreensaverRunning() {
  return running
}

/**
 * Index of the running screensaver, or -1 when none is running.
 *
 * Exported so a caller can step relative to the current pick rather than
 * tracking its own copy of the index -- a duplicate would drift the moment the
 * rotation timer or the start-failure fallback changed the selection without
 * telling the caller.
 *
 * @returns {number}
 */
export function getActiveIndex() {
  return activeIndex
}

/** @returns {number} how many screensavers are registered */
export function screensaverCount() {
  return SCREENSAVERS.length
}
