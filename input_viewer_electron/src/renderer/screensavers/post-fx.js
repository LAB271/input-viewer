// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Post-processing chain for the screensavers (issue #112).
 *
 * Every saver currently renders straight into the 8-bit default framebuffer,
 * which costs three things:
 *
 *   - No glow. Six of the twelve savers are glow-oriented designs and none has
 *     any bloom; bright values just clip.
 *   - Crushed highlights. `min(col, 1.0)` flattens a dense core to featureless
 *     white. Tonemapping rolls it off instead, keeping structure.
 *   - Wrong gamma. Only raymarch encodes sRGB, so every other saver displays
 *     linear values as if they were already sRGB -- darker and more saturated
 *     than intended.
 *
 * Usage: render the scene into `chain.sceneTarget`, then `chain.present()`.
 *
 *   const chain = createPostChain(gl, canvas, { bloom: {...}, tonemap: 'aces' })
 *   gl.bindFramebuffer(gl.FRAMEBUFFER, chain.sceneTarget.fbo)
 *   ... draw ...
 *   chain.present()
 *
 * Returns null when float targets are unavailable, so callers keep their
 * existing direct-to-screen path rather than failing to start.
 */
import { createHdrColorTarget, createFullscreenPass } from './gl-base.js'
import { createUniformCache } from './glsl-lib.js'

/** Mip levels in the bloom pyramid. 6 gives a wide, soft falloff. */
const BLOOM_MIPS = 6

const BRIGHT_PASS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
out vec4 outColor;

// Soft-knee bright pass. A hard threshold produces a visible ring where pixels
// cross it; the knee blends across a band instead.
void main() {
  vec3 c = texture(uSrc, gl_FragCoord.xy * uTexel).rgb;
  float lum = max(max(c.r, c.g), c.b);
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, lum - uThreshold) / max(lum, 1e-5);
  outColor = vec4(c * contribution, 1.0);
}`

// Dual-filter downsample. Cheaper than a separable Gaussian at large radii, and
// the radius stays resolution-independent -- which matters here because a
// Gaussian tuned in pixels on a laptop is far too tight at 6000x1200.
const DOWNSAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel * 2.0;
  vec3 sum = texture(uSrc, uv).rgb * 4.0;
  sum += texture(uSrc, uv - uTexel).rgb;
  sum += texture(uSrc, uv + uTexel).rgb;
  sum += texture(uSrc, uv + vec2(uTexel.x, -uTexel.y)).rgb;
  sum += texture(uSrc, uv - vec2(uTexel.x, -uTexel.y)).rgb;
  outColor = vec4(sum / 8.0, 1.0);
}`

// Tent-filter upsample, added progressively onto the larger mip. The
// accumulate-on-the-way-up shape is what gives a physically plausible wide
// falloff rather than the tight halo of a single blur.
const UPSAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel * 0.5;
  vec2 d = uTexel * uRadius;
  vec3 sum = texture(uSrc, uv + vec2(-d.x, 0.0)).rgb * 2.0;
  sum += texture(uSrc, uv + vec2(d.x, 0.0)).rgb * 2.0;
  sum += texture(uSrc, uv + vec2(0.0, -d.y)).rgb * 2.0;
  sum += texture(uSrc, uv + vec2(0.0, d.y)).rgb * 2.0;
  sum += texture(uSrc, uv).rgb * 4.0;
  sum += texture(uSrc, uv + vec2(-d.x, -d.y)).rgb;
  sum += texture(uSrc, uv + vec2(d.x, -d.y)).rgb;
  sum += texture(uSrc, uv + vec2(-d.x, d.y)).rgb;
  sum += texture(uSrc, uv + vec2(d.x, d.y)).rgb;
  outColor = vec4(sum / 16.0, 1.0);
}`

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomIntensity;
uniform float uExposure;
uniform int uTonemap;      // 0 = none, 1 = Reinhard-Jodie, 2 = ACES
uniform int uDither;
out vec4 outColor;

// ACES filmic, Narkowicz's fitted curve. Rolls highlights off smoothly instead
// of clipping, which is what preserves structure in a dense bright core.
vec3 tonemapACES(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Cheaper alternative that keeps saturation better than plain Reinhard.
vec3 tonemapReinhardJodie(vec3 x) {
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  vec3 tv = x / (1.0 + x);
  return mix(x / (1.0 + l), tv, tv);
}

// Interleaved gradient noise: a cheap, well-distributed dither. Breaking the
// final 8-bit quantisation matters most on wide smooth gradients -- a bloom
// falloff across 6000px of projector is a textbook banding case.
float ignNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec3 color = texture(uScene, uv).rgb;
  color += texture(uBloom, uv).rgb * uBloomIntensity;
  color *= uExposure;

  if (uTonemap == 2) color = tonemapACES(color);
  else if (uTonemap == 1) color = tonemapReinhardJodie(color);
  else color = clamp(color, 0.0, 1.0);

  // Linear -> sRGB. Without this, linear values are displayed as though they
  // were already encoded, which reads darker and over-saturated.
  color = pow(max(color, 0.0), vec3(1.0 / 2.2));

  if (uDither == 1) {
    // +/- half a code value, so it dithers the quantisation step itself.
    color += (ignNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  }

  outColor = vec4(color, 1.0);
}`

const TONEMAP_MODES = { none: 0, reinhard: 1, aces: 2 }

/**
 * Most recently created chain, for the preview harness to tune live.
 *
 * Tuning bloom by editing a constant and restarting is slow and imprecise, and
 * the values are a judgement call that has to be made by eye on the actual
 * display. This lets preview.js adjust them in place. Production code never
 * reads it.
 */
let activeChain = null
export function getActivePostChain() { return activeChain }

/**
 * Build a post-processing chain sized to the canvas.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 * @param {object|false} [options.bloom] - {threshold, knee, intensity, radius}
 * @param {'aces'|'reinhard'|'none'} [options.tonemap]
 * @param {number} [options.exposure]
 * @param {boolean} [options.dither]
 * @returns {object|null} chain, or null if HDR targets are unavailable
 */
export function createPostChain(gl, canvas, options = {}) {
  const {
    bloom = { threshold: 1.0, knee: 0.5, intensity: 0.8, radius: 1.0 },
    tonemap = 'aces',
    exposure = 1.0,
    dither = true,
  } = options

  const sceneTarget = createHdrColorTarget(gl, canvas.width, canvas.height)
  if (!sceneTarget) return null

  // Bloom pyramid: half-resolution base, then successive halvings. Starting at
  // half resolution is standard -- bloom is low-frequency by definition, so
  // full-resolution mips would cost bandwidth for detail nobody can see.
  const mips = []
  if (bloom) {
    let w = Math.max(1, canvas.width >> 1)
    let h = Math.max(1, canvas.height >> 1)
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const t = createHdrColorTarget(gl, w, h)
      if (!t) break
      mips.push(t)
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
    }
  }

  const brightPass = bloom ? createFullscreenPass(gl, BRIGHT_PASS) : null
  const downPass = bloom ? createFullscreenPass(gl, DOWNSAMPLE) : null
  const upPass = bloom ? createFullscreenPass(gl, UPSAMPLE) : null
  const compositePass = createFullscreenPass(gl, COMPOSITE)

  const uBright = brightPass ? createUniformCache(gl, brightPass.program) : null
  const uDown = downPass ? createUniformCache(gl, downPass.program) : null
  const uUp = upPass ? createUniformCache(gl, upPass.program) : null
  const uComp = createUniformCache(gl, compositePass.program)

  function bindTarget(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.w, target.h)
  }

  function buildBloom() {
    if (!mips.length) return null
    gl.disable(gl.BLEND)

    // Bright-pass the scene into the first mip.
    bindTarget(mips[0])
    brightPass.draw((g) => {
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, sceneTarget.tex)
      g.uniform1i(uBright('uSrc'), 0)
      g.uniform2f(uBright('uTexel'), 1 / mips[0].w, 1 / mips[0].h)
      g.uniform1f(uBright('uThreshold'), params.threshold)
      g.uniform1f(uBright('uKnee'), Math.max(1e-4, params.knee))
    })

    // Down the pyramid.
    for (let i = 1; i < mips.length; i++) {
      bindTarget(mips[i])
      downPass.draw((g) => {
        g.activeTexture(g.TEXTURE0)
        g.bindTexture(g.TEXTURE_2D, mips[i - 1].tex)
        g.uniform1i(uDown('uSrc'), 0)
        g.uniform2f(uDown('uTexel'), 1 / mips[i].w, 1 / mips[i].h)
      })
    }

    // Back up, adding each level onto the next larger one.
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    for (let i = mips.length - 1; i > 0; i--) {
      bindTarget(mips[i - 1])
      upPass.draw((g) => {
        g.activeTexture(g.TEXTURE0)
        g.bindTexture(g.TEXTURE_2D, mips[i].tex)
        g.uniform1i(uUp('uSrc'), 0)
        g.uniform2f(uUp('uTexel'), 1 / mips[i - 1].w, 1 / mips[i - 1].h)
        g.uniform1f(uUp('uRadius'), params.radius)
      })
    }
    gl.disable(gl.BLEND)
    return mips[0]
  }

  // Mutable so the preview harness can tune bloom live rather than requiring a
  // rebuild per guess. Production savers set these once at construction.
  const params = {
    threshold: bloom ? (bloom.threshold ?? 1.0) : 0,
    knee: bloom ? Math.max(1e-4, bloom.knee ?? 0.5) : 0.5,
    intensity: bloom ? (bloom.intensity ?? 0.8) : 0,
    radius: bloom ? (bloom.radius ?? 1.0) : 1.0,
    exposure,
  }

  const chain = {
    sceneTarget,
    /** Live-tunable bloom/exposure parameters; see preview.js controls. */
    params,

    /** Match the targets to the canvas. Call after a resize. */
    resize() {
      sceneTarget.resize(canvas.width, canvas.height)
      let w = Math.max(1, canvas.width >> 1)
      let h = Math.max(1, canvas.height >> 1)
      for (const mip of mips) {
        mip.resize(w, h)
        w = Math.max(1, w >> 1)
        h = Math.max(1, h >> 1)
      }
    },

    /** Resolve the HDR scene to the default framebuffer. */
    present() {
      const bloomTarget = buildBloom()

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.disable(gl.BLEND)
      compositePass.draw((g) => {
        g.activeTexture(g.TEXTURE0)
        g.bindTexture(g.TEXTURE_2D, sceneTarget.tex)
        g.uniform1i(uComp('uScene'), 0)
        g.activeTexture(g.TEXTURE1)
        // With bloom disabled, sample the scene and multiply by zero rather
        // than branching on a possibly-unbound texture unit.
        g.bindTexture(g.TEXTURE_2D, (bloomTarget ?? sceneTarget).tex)
        g.uniform1i(uComp('uBloom'), 1)
        g.uniform2f(uComp('uTexel'), 1 / canvas.width, 1 / canvas.height)
        g.uniform1f(uComp('uBloomIntensity'), bloomTarget ? params.intensity : 0)
        g.uniform1f(uComp('uExposure'), params.exposure)
        g.uniform1i(uComp('uTonemap'), TONEMAP_MODES[tonemap] ?? TONEMAP_MODES.aces)
        g.uniform1i(uComp('uDither'), dither ? 1 : 0)
      })
      gl.activeTexture(gl.TEXTURE0)
    },

    destroy() {
      if (activeChain === chain) activeChain = null
      sceneTarget.destroy()
      for (const mip of mips) mip.destroy()
      brightPass?.destroy()
      downPass?.destroy()
      upPass?.destroy()
      compositePass.destroy()
    },
  }
  activeChain = chain
  return chain
}
