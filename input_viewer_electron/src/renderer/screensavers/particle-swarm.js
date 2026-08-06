// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * GPU Particle Swarm — tens of thousands of particles orbiting moving
 * attractors. Particle position+velocity live in float textures, updated by a
 * fullscreen sim pass, then drawn as additive points (the point's vertex
 * shader fetches its position from the state texture by gl_VertexID).
 *
 * Per-activation variation: the two attractors' orbit radii, angular rates and
 * per-axis phase offsets are randomised, along with the attraction and swirl
 * strengths and the palette phase.
 *
 * The phase offsets are the load-bearing part. The attractors were pure
 * functions of a uTime that gl-base.js resets to 0 on every start(), so both
 * always departed from the same point on the same circle and the swarm's whole
 * choreography -- which lobe forms first, where the two streams braid -- was
 * identical every time. Randomising the rates alone would only change the
 * tempo of that same opening; the phases are what move the starting points.
 */
import { createGLRuntime, createFullscreenPass, createPingPong, buildProgram, pointScale, particleSide } from './gl-base.js'
import { createRng } from './seed.js'

const PARTICLES_SIDE = 256 // 256x256 = 65,536 particles
// Scales up with canvas area; capped to bound worst-case GPU cost,
// so very large displays go slightly sparser rather than very expensive.
const MAX_SIDE = 384

const SIM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uState;   // xy=pos (clip space-ish), zw=vel
uniform vec2 uTexel;
uniform float uTime;
uniform float uDt;
uniform vec2 uRadii;    // orbit radius of each attractor
uniform vec4 uOrbitA;   // attractor 1: xy = x/y angular rates, zw = x/y phases
uniform vec4 uOrbitB;   // attractor 2: same layout
uniform vec2 uForce;    // x = attraction strength, y = tangential swirl
out vec4 outState;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 s = texture(uState, uv);
  vec2 pos = s.xy;
  vec2 vel = s.zw;

  // Two orbiting attractors. Radii, rates and phases come from the host so
  // each activation starts them somewhere else on differently-shaped orbits.
  vec2 a1 = uRadii.x * vec2(cos(uTime * uOrbitA.x + uOrbitA.z), sin(uTime * uOrbitA.y + uOrbitA.w));
  vec2 a2 = uRadii.y * vec2(cos(uTime * uOrbitB.x + uOrbitB.z), sin(uTime * uOrbitB.y + uOrbitB.w));

  vec2 d1 = a1 - pos; vec2 d2 = a2 - pos;
  float r1 = max(dot(d1, d1), 0.01);
  float r2 = max(dot(d2, d2), 0.01);
  vec2 acc = d1 / r1 * uForce.x + d2 / r2 * uForce.x;
  // Tangential swirl for orbiting motion.
  acc += vec2(-d1.y, d1.x) / r1 * uForce.y;

  vel += acc * uDt * 60.0;
  vel *= 0.985; // damping
  pos += vel * uDt;

  // Wrap around the [-1,1] box.
  pos = mod(pos + 1.0, 2.0) - 1.0;

  outState = vec4(pos, vel);
}`

const DRAW_VERT = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uSide;
uniform float uScale;
out float vSpeed;
void main() {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / uSide;
  vec4 s = texture(uState, uv);
  vSpeed = length(s.zw);
  gl_Position = vec4(s.xy, 0.0, 1.0);
  gl_PointSize = 1.5 * uScale;
}`

const DRAW_FRAG = `#version 300 es
precision highp float;
in float vSpeed;
uniform vec3 uPhase;
out vec4 outColor;
void main() {
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (vSpeed * 2.0 + uPhase));
  // Multiply blend over a white background ("ink on paper"): emit a value
  // close to 1.0 so a single particle barely tints the paper and overlaps
  // build up saturated color. mix toward white keeps it light and airy.
  vec3 ink = mix(vec3(1.0), col, 0.5);
  outColor = vec4(ink, 1.0);
}`

export default {
  name: 'Particle Swarm',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, drawProg = null, pp = null, vao = null
    let last = 0
    // Resolved in start(), once createGLRuntime has sized the canvas: the
    // particle count scales with canvas area, so it cannot be known here.
    let SIDE = PARTICLES_SIDE
    let COUNT = SIDE * SIDE

    // Drawn here rather than in start() so a start/stop/start cycle keeps the
    // same look; only a fresh create() picks a new one.
    const rng = createRng(seedValue)
    // 0.45..0.75 around the tuned 0.6. Below ~0.4 the two attractors sit close
    // enough to merge into one blob; above ~0.8 they orbit into the wrap seam
    // at |pos| = 1 and the swarm shears instead of braiding.
    const radii = [rng.range(0.45, 0.75), rng.range(0.45, 0.75)]
    // Rates around the tuned (0.5, 0.4) and (0.3, 0.6). Kept apart from each
    // other per attractor: equal x/y rates degenerate the ellipse to a line.
    const orbitA = [rng.around(0.5, 0.15), rng.around(0.4, 0.15), rng.phase(), rng.phase()]
    const orbitB = [rng.around(0.3, 0.12), rng.around(0.6, 0.18), rng.phase(), rng.phase()]
    // Attraction near 0.02 and swirl near 0.01. Both are tight: the 0.985
    // damping is balanced against these, and much more attraction collapses the
    // swarm onto the attractors while much more swirl flings it to the wrap box.
    const force = [rng.range(0.016, 0.026), rng.range(0.007, 0.014)]
    const phase = [rng.next(), rng.next() + 0.33, rng.next() + 0.67]

    function seed() {
      const data = new Float32Array(COUNT * 4)
      for (let i = 0; i < COUNT; i++) {
        data[i * 4 + 0] = rng.range(-1, 1)
        data[i * 4 + 1] = rng.range(-1, 1)
        data[i * 4 + 2] = rng.range(-0.1, 0.1)
        data[i * 4 + 3] = rng.range(-0.1, 0.1)
      }
      return data
    }

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')
        // createGLRuntime has now sized the canvas, so area-based scaling is
        // valid. Must precede seed(), which allocates COUNT particles.
        SIDE = particleSide(canvas, PARTICLES_SIDE, MAX_SIDE)
        COUNT = SIDE * SIDE
        pp = createPingPong(gl, SIDE, SIDE, seed())
        sim = createFullscreenPass(gl, SIM_FRAG)

        // Point-draw program: empty VAO, vertices generated by gl_VertexID,
        // each fetching its particle's position from the state texture.
        drawProg = buildProgram(gl, DRAW_VERT, DRAW_FRAG)
        vao = gl.createVertexArray()

        last = 0
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.DST_COLOR, gl.ZERO) // multiply (ink on white paper)

        runtime.start((time) => {
          const dt = Math.min(time - last, 0.05) || 0.016
          last = time

          // Sim pass.
          gl.disable(gl.BLEND)
          gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
          gl.viewport(0, 0, SIDE, SIDE)
          sim.draw((g, p) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            g.uniform1i(g.getUniformLocation(p, 'uState'), 0)
            g.uniform2f(g.getUniformLocation(p, 'uTexel'), 1 / SIDE, 1 / SIDE)
            g.uniform1f(g.getUniformLocation(p, 'uTime'), time)
            g.uniform1f(g.getUniformLocation(p, 'uDt'), dt)
            g.uniform2f(g.getUniformLocation(p, 'uRadii'), radii[0], radii[1])
            g.uniform4f(g.getUniformLocation(p, 'uOrbitA'), orbitA[0], orbitA[1], orbitA[2], orbitA[3])
            g.uniform4f(g.getUniformLocation(p, 'uOrbitB'), orbitB[0], orbitB[1], orbitB[2], orbitB[3])
            g.uniform2f(g.getUniformLocation(p, 'uForce'), force[0], force[1])
          })
          pp.swap()

          // Draw pass: white paper, multiply-blend colored "ink" particles.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.DST_COLOR, gl.ZERO)
          gl.clearColor(1, 1, 1, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.useProgram(drawProg.program)
          gl.bindVertexArray(vao)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, pp.read.tex)
          gl.uniform1i(gl.getUniformLocation(drawProg.program, 'uState'), 0)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uSide'), SIDE)
          gl.uniform1f(gl.getUniformLocation(drawProg.program, 'uScale'), pointScale(canvas, 1.5))
          gl.uniform3f(gl.getUniformLocation(drawProg.program, 'uPhase'), phase[0], phase[1], phase[2])
          gl.drawArrays(gl.POINTS, 0, COUNT)
        })
      },
      stop() {
        if (sim) { sim.destroy(); sim = null }
        if (drawProg) { drawProg.destroy(); drawProg = null }
        if (vao) { gl.deleteVertexArray(vao); vao = null }
        if (pp) { pp.destroy(); pp = null }
        if (runtime) { runtime.destroy(); runtime = null }
        gl = null
      }
    }
  }
}
