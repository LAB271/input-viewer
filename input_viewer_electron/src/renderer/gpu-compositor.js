// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * WebGPU compositor for the capture feeds (issue #62).
 *
 * WHAT THIS IS FOR
 *
 * The shipping render path does not composite at all: the two <video> elements
 * are laid out with CSS and drawn by Chromium, which already keeps decoded
 * frames on the GPU and never copies them through JavaScript. That is the
 * zero-copy path #62 proposes moving *to*, so there is no CPU compositing loop
 * here to eliminate.
 *
 * This module therefore exists to answer the question #62 actually asks --
 * "benchmark vs current pipeline" -- rather than to replace the default. It
 * imports capture frames as WebGPU external textures and composites them into
 * a single canvas, so the two paths can be measured against each other on real
 * hardware.
 *
 * It is OFF by default and must be enabled explicitly. Enabling it takes over
 * drawing the video, so a failure is a black wall; every entry point below
 * fails closed by reporting unavailability, leaving the CSS path untouched.
 *
 * KNOWN GAP
 *
 * The CSS path also renders the no-signal overlay (scanlines, animated glitch
 * text) and the centre/bottom logos as DOM on top of the video. This composites
 * video only. Those overlays remain DOM elements above the canvas, which works
 * because the canvas sits behind them -- but it means the GPU path is not a
 * drop-in replacement for everything the DOM currently draws.
 */

/** Is WebGPU with external-texture import usable here? */
export async function supportsGpuCompositing() {
  if (!navigator.gpu) return false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

/**
 * The compositing shader.
 *
 * Exported so it can be parse-checked without a GPU. No WebGPU adapter is
 * available in CI or in a headless Electron run -- not even with
 * forceFallbackAdapter -- so this module's runtime path cannot be exercised
 * here. Validating that the WGSL at least parses is the part that can be
 * checked, and it catches the most likely class of mistake in a shader nobody
 * has been able to execute.
 */
export const COMPOSITOR_WGSL = `
struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

// Full-screen triangle pair covering one half of the target, positioned by a
// uniform so the same shader draws the left and right feed.
struct Layout {
  offset: vec2f,
  scale: vec2f,
}
@group(0) @binding(0) var<uniform> layout_: Layout;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_external;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  // Two triangles as a unit quad in [0,1], mapped by offset/scale into clip space.
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let q = quad[i];
  let ndc = (q * layout_.scale + layout_.offset) * 2.0 - 1.0;
  var out: VertexOut;
  // Flip Y: clip space is +Y up, texture space is +Y down.
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  out.uv = q;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, in.uv);
}
`

/**
 * Create a WebGPU compositor drawing capture video into `canvas`.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @returns {Promise<object|null>} compositor, or null if WebGPU is unusable
 */
export async function createGpuCompositor(canvas) {
  if (!navigator.gpu) return null

  let device
  let context
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    device = await adapter.requestDevice()
    context = canvas.getContext('webgpu')
    if (!context) return null
  } catch {
    return null
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const module = device.createShaderModule({ code: COMPOSITOR_WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  // One uniform buffer per feed: offset.xy + scale.xy, padded to 32 bytes.
  const uniforms = [0, 1].map(() => device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  }))

  let destroyed = false

  /**
   * Composite one frame.
   *
   * @param {Array<{video: HTMLVideoElement, offset: [number, number], scale: [number, number]}>} feeds
   *   Each feed's placement in normalised [0,1] target space.
   */
  function draw(feeds) {
    if (destroyed) return

    const view = context.getCurrentTexture().createView()
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(pipeline)

    feeds.forEach((feed, i) => {
      if (i >= uniforms.length) return
      // importExternalTexture is the zero-copy import: the decoded frame stays
      // in GPU memory. The handle is only valid for the current task, so it
      // must be re-imported every frame rather than cached.
      let external
      try {
        external = device.importExternalTexture({ source: feed.video })
      } catch {
        return // Video not ready this frame; leave that region cleared.
      }

      device.queue.writeBuffer(uniforms[i], 0, new Float32Array([
        feed.offset[0], feed.offset[1], feed.scale[0], feed.scale[1],
      ]))

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms[i] } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: external },
        ],
      })
      pass.setBindGroup(0, bindGroup)
      pass.draw(6)
    })

    pass.end()
    device.queue.submit([encoder.finish()])
  }

  return {
    draw,
    destroy() {
      destroyed = true
      for (const b of uniforms) b.destroy()
      device.destroy()
    },
  }
}
