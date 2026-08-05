// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Tests for the experimental WebGPU compositor (issue #62).
 *
 * Scope note: WGSL shader compilation and actual rendering cannot be tested
 * here -- there is no WebGPU adapter in CI or in a headless Electron run, and
 * SwiftShader does not provide one. What IS testable, and what these cover, is
 * the part that decides whether the live video path gets replaced at all:
 * feature detection and its fallbacks. Those are what protect the wall from a
 * black screen, so they are the part worth pinning.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { supportsGpuCompositing, createGpuCompositor } from '../src/renderer/gpu-compositor.js'

const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu')

function setGpu(value) {
  Object.defineProperty(navigator, 'gpu', { value, configurable: true, writable: true })
}

afterEach(() => {
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu)
  else delete navigator.gpu
})

describe('supportsGpuCompositing', () => {
  it('is false when the runtime has no WebGPU at all', async () => {
    setGpu(undefined)
    expect(await supportsGpuCompositing()).toBe(false)
  })

  it('is false when WebGPU exists but yields no adapter', async () => {
    // The real case in headless runs and on machines without a supported GPU.
    setGpu({ requestAdapter: async () => null })
    expect(await supportsGpuCompositing()).toBe(false)
  })

  it('is false when requesting an adapter throws', async () => {
    setGpu({ requestAdapter: async () => { throw new Error('no gpu process') } })
    expect(await supportsGpuCompositing()).toBe(false)
  })

  it('is true when an adapter is available', async () => {
    setGpu({ requestAdapter: async () => ({}) })
    expect(await supportsGpuCompositing()).toBe(true)
  })
})

describe('createGpuCompositor fallback behaviour', () => {
  it('returns null without WebGPU rather than throwing', async () => {
    // Returning null (not throwing) is what lets the caller stay on the CSS
    // path silently; a throw would surface as a startup error.
    setGpu(undefined)
    expect(await createGpuCompositor(document.createElement('canvas'))).toBe(null)
  })

  it('returns null when no adapter is available', async () => {
    setGpu({ requestAdapter: async () => null })
    expect(await createGpuCompositor(document.createElement('canvas'))).toBe(null)
  })

  it('returns null when device creation fails', async () => {
    setGpu({
      requestAdapter: async () => ({ requestDevice: async () => { throw new Error('device lost') } }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    })
    expect(await createGpuCompositor(document.createElement('canvas'))).toBe(null)
  })

  it('returns null when the canvas has no webgpu context', async () => {
    // jsdom canvases have no webgpu context, which is exactly the shape of a
    // browser that advertises WebGPU but cannot give a context for this canvas.
    setGpu({
      requestAdapter: async () => ({ requestDevice: async () => ({ destroy() {} }) }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    })
    const canvas = document.createElement('canvas')
    canvas.getContext = vi.fn(() => null)
    expect(await createGpuCompositor(canvas)).toBe(null)
  })
})
