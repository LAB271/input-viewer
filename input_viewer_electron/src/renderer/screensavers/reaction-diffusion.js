// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Reaction-Diffusion (Gray-Scott) — organic patterns that grow, divide and
 * crawl. Two chemicals A/B simulated on a ping-pong float texture; the B
 * concentration is colored for display. Periodically re-seeds so the pattern
 * keeps evolving rather than settling.
 *
 * Per-activation variation: the (feed, kill) regime is picked from REGIMES
 * below, plus the initial blob count/size, reseed cadence and palette. The
 * regime is the significant one -- it selects which of Gray-Scott's many
 * qualitatively different behaviours the run exhibits, and it used to be a
 * single hardcoded pair.
 */
import { createGLRuntime, createFullscreenPass, createPingPong } from './gl-base.js'
import { createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uFeed;
uniform float uKill;
uniform vec2 uSeed;   // seed location (or <0 for none)
out vec4 outState;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 s = texture(uState, uv).xy;
  // Laplacian (3x3 kernel).
  vec2 lap = vec2(0.0);
  lap += texture(uState, uv + vec2(-1.0, 0.0) * uTexel).xy * 0.2;
  lap += texture(uState, uv + vec2( 1.0, 0.0) * uTexel).xy * 0.2;
  lap += texture(uState, uv + vec2( 0.0,-1.0) * uTexel).xy * 0.2;
  lap += texture(uState, uv + vec2( 0.0, 1.0) * uTexel).xy * 0.2;
  lap += texture(uState, uv + vec2(-1.0,-1.0) * uTexel).xy * 0.05;
  lap += texture(uState, uv + vec2( 1.0,-1.0) * uTexel).xy * 0.05;
  lap += texture(uState, uv + vec2(-1.0, 1.0) * uTexel).xy * 0.05;
  lap += texture(uState, uv + vec2( 1.0, 1.0) * uTexel).xy * 0.05;
  lap -= s;

  float A = s.x, B = s.y;
  // Canonical Gray-Scott diffusion rates (Karl Sims). Higher rates diffuse
  // the field to a uniform value within a few steps -> solid color, so keep
  // these modest.
  float dA = 0.2097, dB = 0.105;
  float reaction = A * B * B;
  float na = A + (dA * lap.x - reaction + uFeed * (1.0 - A));
  float nb = B + (dB * lap.y + reaction - (uKill + uFeed) * B);

  // Optional seed splat.
  if (uSeed.x >= 0.0) {
    float d = distance(uv, uSeed);
    if (d < 0.02) nb = 1.0;
  }

  outState = vec4(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}`

const DISPLAY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uResolution;  // canvas size in pixels
uniform float uTime;
uniform vec3 uPhase;
out vec4 outColor;

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.2831 * (t + uPhase));
}

void main() {
  // Map the full canvas to the [0,1] simulation texture, preserving the
  // square grid's aspect by covering the screen (centered).
  vec2 uv = gl_FragCoord.xy / uResolution;
  float b = texture(uState, uv).y;
  float v = smoothstep(0.1, 0.5, b);
  vec3 col = palette(v * 0.8 + uTime * 0.03) * v;
  col += vec3(0.02, 0.0, 0.04); // dim background
  outColor = vec4(col, 1.0);
}`

// Gray-Scott (feed, kill) regimes, each a qualitatively different morphology
// from the well-known "Gray-Scott zoo". This pair is by far the biggest lever on
// what the simulation looks like, and it was previously a single hardcoded point
// -- so the saver only ever showed one of the many behaviours the system has.
//
// Curated rather than sampled: most of (f,k) space either dies to a uniform
// field within seconds or saturates to solid B, and both look broken on a wall.
//
// Every pair here satisfies the Gray-Scott existence bound k < sqrt(f)/2 - f,
// below which no non-trivial steady state exists and B decays to zero -- i.e.
// the screen fades to the flat background and stays there. Worth stating
// explicitly because it is not obvious by eye on a short preview, and because
// several plausible-looking literature coordinates (including the f=0.0367,
// k=0.0649 pair this saver originally shipped) sit outside it; that one survives
// in practice only because the periodic reseed keeps re-injecting B.
// If you add a regime, check it against the bound.
const REGIMES = [
  { feed: 0.0367, kill: 0.0573, name: 'mitosis' },
  { feed: 0.0545, kill: 0.0604, name: 'coral' },
  { feed: 0.0295, kill: 0.0547, name: 'worms' },
  { feed: 0.0250, kill: 0.0524, name: 'solitons' },
  { feed: 0.0390, kill: 0.0579, name: 'labyrinth' },
  { feed: 0.0180, kill: 0.0476, name: 'moving spots' },
  { feed: 0.0620, kill: 0.0606, name: 'u-skate' },
  { feed: 0.0340, kill: 0.0564, name: 'spots and stripes' }
]

export default {
  name: 'Reaction Diffusion',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, display = null, pp = null
    const SIM = 320 // simulation grid resolution (square)
    let seedTimer = 0

    const rng = createRng(seedValue)
    const regime = rng.pick(REGIMES)
    const palettePhase = [rng.next(), rng.next() + 0.33, rng.next() + 0.6]
    // Blob count and size vary the initial condition, which for Gray-Scott
    // meaningfully changes how the pattern organises -- a few large blobs grow
    // into different structure than many small ones.
    const blobCount = rng.int(8, 30)
    const blobRadius = rng.int(3, 9)
    // Reseed cadence in frames. Previously a fixed 240, so the first reseed
    // always landed at the same moment.
    const reseedEvery = rng.int(150, 420)

    function makeSeed() {
      // Fill mostly A=1, B=0, with a few random B blobs.
      const data = new Float32Array(SIM * SIM * 4)
      for (let i = 0; i < SIM * SIM; i++) {
        data[i * 4 + 0] = 1.0
        data[i * 4 + 3] = 1.0
      }
      for (let s = 0; s < blobCount; s++) {
        const cx = rng.int(0, SIM - 1)
        const cy = rng.int(0, SIM - 1)
        for (let y = -blobRadius; y <= blobRadius; y++) {
          for (let x = -blobRadius; x <= blobRadius; x++) {
            const px = cx + x, py = cy + y
            if (px < 0 || py < 0 || px >= SIM || py >= SIM) continue
            data[(py * SIM + px) * 4 + 1] = 1.0
          }
        }
      }
      return data
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        pp = createPingPong(gl, SIM, SIM, makeSeed())
        sim = createFullscreenPass(gl, SIM_FRAG)
        display = createFullscreenPass(gl, DISPLAY_FRAG)
        // Uniform locations are fixed for a program's lifetime. Looking them up
        // inside the draw callback meant 5 string-keyed driver queries x 8
        // substeps = 40 per frame, for values that never move (issue #115).
        const uSim = createUniformCache(gl, sim.program)
        const uDisplay = createUniformCache(gl, display.program)

        runtime.start((time) => {
          // Several simulation substeps per frame for faster evolution.
          const steps = 8
          // Re-seed occasionally to keep it lively.
          let seedX = -1, seedY = -1
          seedTimer += 1
          if (seedTimer > reseedEvery) {
            seedTimer = 0
            seedX = rng.next()
            seedY = rng.next()
          }
          for (let i = 0; i < steps; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
            gl.viewport(0, 0, SIM, SIM)
            sim.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, pp.read.tex)
              g.uniform1i(uSim('uState'), 0)
              g.uniform2f(uSim('uTexel'), 1 / SIM, 1 / SIM)
              g.uniform1f(uSim('uFeed'), regime.feed)
              g.uniform1f(uSim('uKill'), regime.kill)
              const sx = i === 0 ? seedX : -1
              g.uniform2f(uSim('uSeed'), sx, sx >= 0 ? seedY : -1)
            })
            pp.swap()
          }

          // Display pass to the screen.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(uDisplay('uState'), 0)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform1f(uDisplay('uTime'), time)
            g.uniform3f(uDisplay('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
          })
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (display) { display.destroy(); display = null }
        if (pp) { pp.destroy(); pp = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
