// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Voronoi — drifting cell sites partition the surface into polygonal regions,
 * with bright rims where two sites are equidistant. The tessellation
 * continuously reshapes as the sites move and cells trade territory.
 *
 * Chosen first from the screensaver wishlist because it is the brightest,
 * highest-contrast design in the set (issue #97). That matters directly for
 * #88: the dim-on-black savers wash out under ambient light on the projector,
 * and filled polygons with lit edges have far more luminance headroom than
 * particles or thin lines.
 *
 * Pure fragment shader with no simulation state -- sites are integrated on the
 * CPU and uploaded as uniforms, and the per-pixel work is just a nearest and
 * second-nearest search.
 *
 * Per-activation variation: site count, drift speed, palette phase, rim
 * intensity and the cell-shading balance are all randomised.
 */
import { createGLRuntime, luminanceScale } from './gl-base.js'
import { GLSL, canvasAspect, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'
import { createPostChain } from './post-fx.js'

// Upper bound on sites. The shader loops over a fixed-size array because GLSL
// ES 3.00 requires a constant loop bound; uSiteCount masks off the unused tail.
const MAX_SITES = 32

const FRAG = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec2 uSites[${MAX_SITES}];   // world space
uniform int uSiteCount;
uniform vec3 uPhase;
uniform float uRimGain;
uniform float uCellFill;   // how strongly cells are tinted vs. left dark
uniform float uLum;
out vec4 outColor;

${GLSL.worldSpace}
${GLSL.palette}
${GLSL.hash}

void main() {
  // World space, so cells are the shape they should be rather than stretched
  // 5:1 on the wall (issue #114 -- and the trap #97 explicitly warns about).
  vec2 p = worldFromFrag(gl_FragCoord.xy, iResolution.xy);

  float nearest = 1e9, second = 1e9;
  int nearestIdx = 0;

  for (int i = 0; i < ${MAX_SITES}; i++) {
    if (i >= uSiteCount) break;
    vec2 d = uSites[i] - p;
    float dist2 = dot(d, d);
    if (dist2 < nearest) {
      second = nearest;
      nearest = dist2;
      nearestIdx = i;
    } else if (dist2 < second) {
      second = dist2;
    }
  }

  // Distance to the cell boundary. Comparing the *square* distances would bias
  // the rim toward distant sites, so both are rooted first -- this difference
  // is the whole look, per #97.
  float edge = sqrt(second) - sqrt(nearest);

  // Rim: bright, thin, and slightly wider on large displays so it stays
  // visible at distance rather than thinning to nothing.
  float rimWidth = 0.012;
  float rim = 1.0 - smoothstep(0.0, rimWidth, edge);

  // Cell colour from a hash of the site index, so neighbours differ.
  float hue = hashF(hashU(uint(nearestIdx) * 2654435761u));
  vec3 cell = palettePerceptual(hue + iTime * 0.01, uPhase);

  // Shade the interior by distance from the site: a flat fill reads as a
  // mosaic, a gradient gives the cells some body.
  float body = 1.0 - smoothstep(0.0, 0.55, sqrt(nearest));
  vec3 col = cell * (0.25 + uCellFill * body);

  // The rim picks up the cell's own hue, shifted bright, rather than plain
  // white -- keeps the palette coherent instead of washing out to grey.
  col += cell * rim * uRimGain;

  outColor = vec4(col * uLum, 1.0);
}`

export default {
  name: 'Voronoi',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let prog = null, post = null
    let aspect = 1

    const rng = createRng(seedValue)
    // Fewer sites read as bold territory, more as fine crystal. Both work; the
    // ceiling is MAX_SITES and the floor keeps cells large enough to see.
    const siteCount = rng.int(14, MAX_SITES)
    // Slow. Fast sites make cell ownership flip rapidly, which reads as
    // flicker rather than motion -- #97 flags this specifically.
    const speed = rng.range(0.010, 0.028)
    const phase = [rng.next(), rng.next() + 0.33, rng.next() + 0.67]
    const rimGain = rng.range(0.55, 1.0)
    const cellFill = rng.range(0.35, 0.7)

    // Sites live in world space: y in [-0.5, 0.5], x scaled by aspect.
    const sites = []

    function seedSites() {
      sites.length = 0
      for (let i = 0; i < siteCount; i++) {
        const angle = rng.angle()
        sites.push({
          x: rng.range(-0.5, 0.5) * aspect,
          y: rng.range(-0.5, 0.5),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
        })
      }
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        aspect = canvasAspect(canvas)
        seedSites()

        prog = runtime.createQuadProgram(FRAG)
        const u = createUniformCache(gl, prog.program)

        // Bloom on the rims. Threshold above the cell bodies so the fill does
        // not glow -- only the lit edges, which is where the contrast is.
        post = createPostChain(gl, canvas, {
          bloom: {
            threshold: 0.55 * luminanceScale(canvas),
            knee: 0.3,
            intensity: 0.25,
            radius: 0.8,
          },
          tonemap: 'aces',
          dither: true,
        })

        const flat = new Float32Array(MAX_SITES * 2)

        runtime.start((time, frame, glCtx, rt) => {
          const dt = rt.dt
          const halfW = 0.5 * aspect

          for (const s of sites) {
            s.x += s.vx * dt
            s.y += s.vy * dt
            // Bounce rather than wrap: a site crossing the edge would make its
            // whole cell jump to the far side, which is very visible.
            if (s.x < -halfW || s.x > halfW) {
              s.vx = -s.vx
              s.x = Math.min(halfW, Math.max(-halfW, s.x))
            }
            if (s.y < -0.5 || s.y > 0.5) {
              s.vy = -s.vy
              s.y = Math.min(0.5, Math.max(-0.5, s.y))
            }
          }

          for (let i = 0; i < sites.length; i++) {
            flat[i * 2] = sites[i].x
            flat[i * 2 + 1] = sites[i].y
          }

          if (post) {
            post.resize()
            gl.bindFramebuffer(gl.FRAMEBUFFER, post.sceneTarget.fbo)
            gl.viewport(0, 0, canvas.width, canvas.height)
          }

          prog.draw(time, frame, (g) => {
            g.uniform2fv(u('uSites'), flat)
            g.uniform1i(u('uSiteCount'), sites.length)
            g.uniform3f(u('uPhase'), phase[0], phase[1], phase[2])
            g.uniform1f(u('uRimGain'), rimGain)
            g.uniform1f(u('uCellFill'), cellFill)
            g.uniform1f(u('uLum'), luminanceScale(canvas))
          })

          if (post) post.present()
        })
      },
      stop() {
        if (post) { post.destroy(); post = null }
        if (prog) { prog.destroy(); prog = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      },
    }
  },
}
