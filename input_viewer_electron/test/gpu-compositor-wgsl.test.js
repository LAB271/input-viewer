// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Structural checks on the WebGPU compositor's WGSL (issue #62).
 *
 * SCOPE, STATED PLAINLY: this shader has never executed. No WebGPU adapter is
 * obtainable in CI or in a headless Electron run -- `navigator.gpu` exists but
 * `requestAdapter()` returns null even with `forceFallbackAdapter: true` and
 * SwiftShader forced on the command line. So the compositor's runtime path
 * cannot be exercised here at all, which is precisely why it ships dormant
 * behind the `gpuCompositing` setting.
 *
 * What IS checkable is the shader's structure: that the entry points the
 * pipeline names actually exist, that every binding the JS side sets up is
 * declared, and that the uniform block matches the buffer size allocated for
 * it. Those are the mistakes most likely to be sitting in code nobody has run,
 * and each one would surface as a link-time failure on the first machine that
 * does have a GPU.
 *
 * This is not a substitute for running it. It is the strongest check available
 * without hardware.
 */
import { describe, it, expect } from 'vitest'
import { COMPOSITOR_WGSL } from '../src/renderer/gpu-compositor.js'

describe('compositor WGSL structure', () => {
  it('declares the entry points the render pipeline names', () => {
    // createGpuCompositor passes entryPoint: 'vs' and 'fs'. A mismatch here is
    // a pipeline-creation error at runtime, not a compile error.
    expect(COMPOSITOR_WGSL).toMatch(/@vertex\s+fn vs\(/)
    expect(COMPOSITOR_WGSL).toMatch(/@fragment\s+fn fs\(/)
  })

  it('declares all three bindings the bind group provides', () => {
    // The JS builds entries for bindings 0 (uniform), 1 (sampler), 2 (texture).
    // A declared-but-unused or missing binding fails bind group creation.
    expect(COMPOSITOR_WGSL).toMatch(/@group\(0\) @binding\(0\)[^;]*uniform/)
    expect(COMPOSITOR_WGSL).toMatch(/@group\(0\) @binding\(1\)[^;]*sampler/)
    expect(COMPOSITOR_WGSL).toMatch(/@group\(0\) @binding\(2\)[^;]*texture_external/)
  })

  it('uses texture_external, which is the zero-copy import path', () => {
    // The whole premise of #62 is importing decoded video frames without a
    // copy. A plain texture_2d would mean something has gone wrong.
    expect(COMPOSITOR_WGSL).toContain('texture_external')
    expect(COMPOSITOR_WGSL).toContain('textureSampleBaseClampToEdge')
  })

  it('has a uniform struct that fits the allocated buffer', () => {
    // createGpuCompositor allocates 32 bytes per feed. The struct is two vec2f
    // (offset, scale) = 16 bytes, so it fits with padding to spare. If the
    // struct grows past 32 bytes the writeBuffer would silently truncate.
    const struct = COMPOSITOR_WGSL.match(/struct Layout \{([\s\S]*?)\}/)
    expect(struct, 'Layout struct not found').toBeTruthy()
    const vec2Count = (struct[1].match(/vec2f/g) || []).length
    expect(vec2Count).toBe(2)
    expect(vec2Count * 8).toBeLessThanOrEqual(32)
  })

  it('emits six vertices for the quad the draw call requests', () => {
    // pass.draw(6) -- the array must hold exactly that many corners or the
    // shader indexes out of bounds.
    const quad = COMPOSITOR_WGSL.match(/array<vec2f, (\d+)>/)
    expect(quad, 'quad array not found').toBeTruthy()
    expect(Number(quad[1])).toBe(6)
    // And the array literal really lists six corners.
    const corners = (COMPOSITOR_WGSL.match(/vec2f\([-\d.]+, [-\d.]+\)/g) || []).length
    expect(corners).toBeGreaterThanOrEqual(6)
  })

  it('flips Y, since clip space and texture space disagree', () => {
    // Without the flip the composited video is upside down -- a mistake that
    // compiles perfectly and is only visible on screen.
    expect(COMPOSITOR_WGSL).toMatch(/vec4f\(ndc\.x, -ndc\.y/)
  })

  it('has balanced braces, so the source is not truncated', () => {
    const open = (COMPOSITOR_WGSL.match(/\{/g) || []).length
    const close = (COMPOSITOR_WGSL.match(/\}/g) || []).length
    expect(open).toBe(close)
  })

  it('contains no JS template-literal syntax that would break interpolation', () => {
    // A stray backtick inside the template literal terminates it early; that
    // exact mistake has broken the build twice in this codebase.
    expect(COMPOSITOR_WGSL).not.toContain('`')
    expect(COMPOSITOR_WGSL).not.toContain('${')
  })
})
