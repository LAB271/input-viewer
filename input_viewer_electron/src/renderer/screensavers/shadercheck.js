// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Drives every registered screensaver through a real WebGL2 context so the GPU
 * driver actually compiles and links its shaders.
 *
 * Each saver is started, allowed to render a few frames (some build programs
 * lazily on the first frame, and simulation savers only touch their sim shader
 * inside the render loop), then stopped. Anything thrown is captured.
 *
 * Also verifies each saver twice with a pinned seed and once with a fresh one:
 * a randomised constant that lands outside a shader's valid range would only
 * fail for some seeds, so a single run is not enough coverage.
 */
import { SCREENSAVERS } from './registry.js'

const out = document.getElementById('out')
const canvas = document.getElementById('screensaver-canvas')

const log = (msg) => {
  out.textContent += msg + '\n'
  console.log(msg)
}

// Drive create()/start() directly rather than going through
// registry.startScreensaver(). The registry deliberately swallows a start
// failure and falls back to the DVD logo, which is right for production -- a
// broken shader should not leave a blank wall -- but it means a failure is
// invisible to a caller. An earlier version of this harness used the registry
// and reported 60/60 passing while the driver was in fact rejecting a shader.
//
// Console errors are captured too, since that is where the registry's own
// fallback path reports and where a driver warning would surface.
const consoleErrors = []
const nativeError = console.error.bind(console)
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a && a.stack ? a.stack : String(a))).join(' '))
  nativeError(...args)
}

/** Wait n animation frames. */
const frames = (n) => new Promise((resolve) => {
  let left = n
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
})

async function run() {
  const results = []

  // Several seeds per saver: the randomised ranges are the new risk surface, so
  // exercise more than one point in them. Fixed seeds keep the run reproducible.
  const seeds = [1, 2, 12345, 999999, 'abc']

  for (let i = 0; i < SCREENSAVERS.length; i++) {
    const saver = SCREENSAVERS[i]
    const name = saver.name
    for (const seed of seeds) {
      let error = null
      let instance = null
      const errorsBefore = consoleErrors.length
      try {
        instance = saver.create(canvas, seed)
        instance.start()
        // 5 frames: enough for lazy program creation and for simulation savers
        // to have run their sim pass at least once.
        await frames(5)
      } catch (err) {
        error = err && err.message ? err.message : String(err)
      }
      if (instance) {
        try { instance.stop() } catch (err) {
          if (!error) error = `stop() threw: ${err && err.message ? err.message : err}`
        }
      }
      // A saver that logs an error without throwing still counts as a failure.
      const newErrors = consoleErrors.slice(errorsBefore)
      if (!error && newErrors.length) error = newErrors.join('\n')
      results.push({ name, seed: String(seed), error })
      if (error) log(`FAIL  ${name} (seed ${seed})\n${error}\n`)
    }
  }

  const failed = results.filter((r) => r.error)
  log(`\n--- ${results.length - failed.length}/${results.length} runs OK ---`)
  if (failed.length) {
    const byName = [...new Set(failed.map((f) => f.name))]
    log(`FAILING SAVERS: ${byName.join(', ')}`)
  }

  // Console-visible sentinel the headless runner greps for.
  console.log(`SHADERCHECK_DONE ok=${results.length - failed.length} fail=${failed.length}`)
  window.__SHADERCHECK__ = { results, failed: failed.length }
}

run().catch((err) => {
  log(`HARNESS ERROR: ${err && err.stack ? err.stack : err}`)
  console.log('SHADERCHECK_DONE ok=0 fail=-1')
})
