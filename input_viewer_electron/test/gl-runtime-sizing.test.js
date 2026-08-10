// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * createGLRuntime must size the canvas before it returns (issue #190).
 *
 * Fifteen savers derive something from canvas dimensions -- canvasAspect(),
 * particleSide(), pointScale(), luminanceScale(), a simulation grid, an HDR
 * target -- in the window between createGLRuntime() and runtime.start().
 * resize() used to run only inside start(), so those reads saw whatever the
 * canvas was beforehand, and on a canvas nothing had sized yet that is the HTML
 * default 300x150.
 *
 * The bug was intermittent, which is why it survived: the registry shares one
 * canvas across savers, so once any saver had run the backing store stayed
 * sized and the next saver's early read was correct. Only the first saver after
 * page load was wrong. A test that runs a saver second would therefore pass
 * against the bug -- so this one asserts on a FRESH canvas specifically.
 *
 * There is no WebGL2 context in jsdom, so `gl` is a permissive stub. That is
 * enough: the thing under test is when `canvas.width` is assigned, which is
 * plain DOM work. It does mean the stub has to be kept in step with whatever GL
 * calls createGLRuntime makes at construction time -- if this file starts
 * failing with "not a function", that is the cause, and adding the method to
 * the stub is the fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createGLRuntime } from '../src/renderer/screensavers/gl-base.js'
import { canvasAspect } from '../src/renderer/screensavers/glsl-lib.js'

/** Minimal WebGL2 stand-in: every method a no-op, every constant a number. */
function stubGL() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'canvas') return undefined
      if (!(prop in target)) {
        // Constants read as numbers, everything else is callable.
        target[prop] = typeof prop === 'string' && prop === prop.toUpperCase()
          ? 1
          : vi.fn(() => ({}))
      }
      return target[prop]
    }
  })
}

/**
 * A canvas whose CSS box is `w x h` but whose backing store starts at the HTML
 * default, which is the state the bug depended on.
 */
function freshCanvas(w, h) {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: h, configurable: true })
  canvas.getContext = () => stubGL()
  return canvas
}

describe('createGLRuntime canvas sizing (#190)', () => {
  beforeEach(() => {
    window.devicePixelRatio = 1
  })

  it('leaves a fresh canvas at the HTML default before anything sizes it', () => {
    // Guards the premise. If jsdom ever changed this default the test below
    // would pass for the wrong reason.
    const canvas = freshCanvas(6000, 1200)
    expect(canvas.width).toBe(300)
    expect(canvas.height).toBe(150)
  })

  it('sizes the backing store from the CSS box before returning', () => {
    const canvas = freshCanvas(6000, 1200)
    createGLRuntime(canvas)
    expect(canvas.width).toBe(6000)
    expect(canvas.height).toBe(1200)
  })

  it('gives callers the real aspect ratio, not the 300x150 default', () => {
    // This is the failure that reached the wall: aspect 2.0 instead of 5.0, so
    // world space was 2.5x too narrow for every saver that ran first.
    const canvas = freshCanvas(6000, 1200)
    createGLRuntime(canvas)
    expect(canvasAspect(canvas)).toBeCloseTo(5, 6)
    expect(canvasAspect(canvas)).not.toBeCloseTo(2, 1)
  })

  it('gives callers the real pixel area, not 45,000 px', () => {
    // particleSide() and luminanceScale() scale with area, so the pre-fix read
    // was 45,000 px against the wall's 7.2M -- a 160x error.
    const canvas = freshCanvas(6000, 1200)
    createGLRuntime(canvas)
    expect(canvas.width * canvas.height).toBe(7_200_000)
  })

  it('honours devicePixelRatio, capped at 2 as resize() does', () => {
    window.devicePixelRatio = 3
    const canvas = freshCanvas(800, 600)
    createGLRuntime(canvas)
    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(1200)
  })

  it('is correct for a simulation grid derived at construction time', () => {
    // The shape of the read in falling-sand, frost, wave-tank, game-of-life and
    // reaction-diffusion: cells = canvas.width / CELL_PX.
    const CELL_PX = 5
    const canvas = freshCanvas(6000, 1200)
    createGLRuntime(canvas)
    expect(Math.round(canvas.width / CELL_PX)).toBe(1200)
    // Against the bug this was round(300 / 5) = 60 columns for a whole wall.
    expect(Math.round(canvas.width / CELL_PX)).not.toBe(60)
  })
})
