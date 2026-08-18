// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Wave tank — a 2D damped wave equation over the surface, with drops
 * perturbing it so ripples spread, reflect and interfere (#96).
 *
 * Structurally the same shape as reaction-diffusion.js: a ping-pong float
 * texture with a stencil update per step. That machinery is known to work, so
 * this is mostly a shader swap.
 *
 * Two details from #96 are load-bearing:
 *
 * 1. **Shade by slope, not by height.** Sampling the horizontal derivative and
 *    using it as a lighting term is what makes this read as a water surface.
 *    Colouring by amplitude alone looks like a false-colour heightmap.
 *
 * 2. **Damping just under 1.** Too low and ripples die before they interfere;
 *    at or above 1 the scheme is unstable and the surface blows up. 0.978 is
 *    the prototype's value and holds.
 *
 * Boundaries are reflective walls -- the update only touches interior cells, so
 * ripples bounce off the frame. #96 offers a borderless variant via REPEAT
 * wrapping, but "tank with walls" is both the easier option and the better
 * looking one, so it is the deliberate choice rather than an accident of
 * createFloatTarget hardcoding CLAMP_TO_EDGE.
 *
 * Per-activation variation: drop cadence and size, damping within its stable
 * band, wave speed and palette.
 */
import {
  createGLRuntime,
  createFullscreenPass,
  createPingPong,
  luminanceScale
} from './gl-base.js'
import { GLSL, createUniformCache } from './glsl-lib.js'
import { createRng } from './seed.js'

// Simulation cells per device pixel. Was 4, on the argument that ripples are
// many cells wide so a quarter-res grid "looks identical" -- true at 1080p, and
// #184 measured it as visibly soft at 6000x1200, where the upsample is 4x.
const CELL_PX = 2
// Cell budget along the LONGEST axis. Applied to the long axis and the short one
// scaled to match, which is a fix in itself: the previous code clamped each axis
// independently, so at 6000x1200 the grid came out 1024x300 -- 3.41:1 against a
// 5:1 canvas, stretching every ripple 1.46x horizontally. It only showed up at
// wall resolution, because 3000x600 never reaches the cap.
const MAX_CELLS = 2048
const MIN_CELLS = 64

// Simulation steps per second of WALL CLOCK, not per frame. The previous fixed
// two-steps-per-frame made both wave speed and decay depend on the frame rate:
// the same tank ran twice as fast on a 120Hz panel as on a 60Hz one. Deriving the
// count from dt keeps the physics wall-clock consistent, the same reasoning the
// trails elsewhere in this codebase use.
const SIM_STEPS_PER_SECOND = 240
const MAX_STEPS_PER_FRAME = 6

const SIM_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;   // r = current height, g = previous height
uniform vec2 uTexel;
uniform float uDamping;
uniform vec4 uSrcA;         // xy = position (0..1), z = radius in texels, w = amplitude
uniform vec4 uSrcB;
uniform vec4 uBarrier;      // x = centre x (0..1), y = slit centre y, z = slit half height, w = on
out vec4 fragColor;

// Barrier half-thickness, in UV. Shared by both passes so the wall the physics
// blocks is exactly the wall you can see. Tying it to uTexel (the first attempt)
// made the drawn wall about three pixels wide -- present in the simulation,
// invisible on screen.
const float BARRIER_HALF_W = 0.0018;

// A source displaces the surface over a cosine profile. A hard disc injects
// frequencies the grid cannot represent, which spreads as square artefacts.
float sourceAt(vec4 src, vec2 uv, vec2 texel) {
  if (src.z <= 0.0) return 0.0;
  float d = length((uv - src.xy) / texel);
  if (d >= src.z) return 0.0;
  return cos(d / src.z * 1.5707963) * src.w;
}

// The barrier is a vertical wall with a gap. Cells inside it are held at zero,
// exactly like the tank boundary, so a wave reflects off the wall and diffracts
// through the gap -- which is what a wave tank in a physics lab is FOR.
bool insideBarrier(vec2 uv, vec2 texel) {
  if (uBarrier.w < 0.5) return false;
  bool inWall = abs(uv.x - uBarrier.x) < BARRIER_HALF_W;
  bool inSlit = abs(uv.y - uBarrier.y) < uBarrier.z;
  return inWall && !inSlit;
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;

  // Reflective walls: the update only touches interior cells, so the boundary
  // holds its value and ripples bounce. This is the tank look #96 prefers.
  bool edge = uv.x < uTexel.x * 1.5 || uv.x > 1.0 - uTexel.x * 1.5 ||
              uv.y < uTexel.y * 1.5 || uv.y > 1.0 - uTexel.y * 1.5;
  if (edge || insideBarrier(uv, uTexel)) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float here = texture(uState, uv).r;
  float prev = texture(uState, uv).g;

  float n = texture(uState, uv + vec2(0.0, uTexel.y)).r
          + texture(uState, uv - vec2(0.0, uTexel.y)).r
          + texture(uState, uv + vec2(uTexel.x, 0.0)).r
          + texture(uState, uv - vec2(uTexel.x, 0.0)).r;

  // Discrete wave step, second-order. With the neighbourSum/2 - prev form the
  // CFL number is 0.5, so a disturbance travels sqrt(0.5) ~ 0.707 cells per step.
  float next = (n * 0.5 - prev) * uDamping;

  // Sources are applied after the step, so a displacement is genuine rather than
  // something the stencil immediately averages away.
  next -= sourceAt(uSrcA, uv, uTexel);
  next -= sourceAt(uSrcB, uv, uTexel);

  fragColor = vec4(next, here, 0.0, 1.0);
}
`

const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform vec3 uPhase;
uniform float uLumaScale;
uniform vec4 uBarrier;
out vec4 fragColor;

${GLSL.palette}

// Barrier half-thickness, in UV. Shared by both passes so the wall the physics
// blocks is exactly the wall you can see. Tying it to uTexel (the first attempt)
// made the drawn wall about three pixels wide -- present in the simulation,
// invisible on screen.
const float BARRIER_HALF_W = 0.0018;

// Pool floor: large tiles with grout. Something with structure has to be down
// there, because refraction and caustics are only visible as distortion OF
// something -- over a flat colour they are invisible.
vec3 floorColour(vec2 p) {
  vec2 g = abs(fract(p * vec2(7.0, 3.0)) - 0.5);
  float grout = smoothstep(0.40, 0.49, max(g.x, g.y));
  vec3 tile = palettePerceptual(0.55 + uPhase.x, uPhase) * 0.30;
  return mix(tile, tile * 0.45, grout);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  float here = texture(uState, uv).r;

  // Slope, not height. Colouring by amplitude alone gives a false-colour
  // heightmap; a real surface is visible through how it redirects light.
  float hxp = texture(uState, uv + vec2(uTexel.x, 0.0)).r;
  float hxm = texture(uState, uv - vec2(uTexel.x, 0.0)).r;
  float hyp = texture(uState, uv + vec2(0.0, uTexel.y)).r;
  float hym = texture(uState, uv - vec2(0.0, uTexel.y)).r;
  float hx = hxp - hxm;
  float hy = hyp - hym;

  vec3 normal = normalize(vec3(-hx * 14.0, -hy * 14.0, 1.0));
  vec3 lightDir = normalize(vec3(-0.55, 0.6, 0.58));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // REFRACTION. The floor is sampled through the surface, displaced by the
  // gradient -- the standard thin-surface approximation, and enough to make the
  // tiles ripple as waves pass over them.
  vec2 refr = uv + vec2(hx, hy) * 0.55;
  vec3 bed = floorColour(refr);

  // CAUSTICS. The Laplacian of the height field is its curvature, and curvature
  // is what converges or diverges refracted rays: a concave patch focuses light
  // into a bright line on the floor, which is the dancing net in a real pool.
  // Cheap here because the four neighbours were already fetched for the gradient.
  float lap = (hxp + hxm + hyp + hym) - 4.0 * here;
  float focus = max(0.0, -lap * 140.0);
  float caustic = pow(focus, 1.4);
  bed += vec3(0.75, 0.92, 1.0) * caustic * 0.85;

  // Depth tint: the bed is seen through water, so it loses contrast with depth.
  float depthFade = 0.55;
  vec3 col = mix(bed, palettePerceptual(0.62 + uPhase.x, uPhase) * 0.10, depthFade);

  // FRESNEL. At a glancing angle the surface mirrors the sky rather than showing
  // the floor, which is what stops it reading as coloured glass.
  vec3 sky = mix(palettePerceptual(0.58 + uPhase.x, uPhase) * 0.45,
                 palettePerceptual(0.44 + uPhase.x, uPhase) * 0.95,
                 clamp(uv.y * 1.2, 0.0, 1.0));
  float fres = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);
  col = mix(col, sky, clamp(fres * 2.2, 0.0, 0.7));

  // Specular gives the bright crests that make interference legible across a
  // room; the diffuse term alone is too soft to read at distance.
  vec3 halfway = normalize(lightDir + viewDir);
  float spec = pow(max(dot(normal, halfway), 0.0), 48.0);
  col += vec3(0.95, 0.98, 1.0) * spec * 0.9;

  float diffuse = max(dot(normal, lightDir), 0.0);
  col += palettePerceptual(0.45 + uPhase.x, uPhase) * diffuse * 0.18;

  // The barrier is drawn as a solid dark wall so the diffraction has something
  // visible to be diffracting around.
  if (uBarrier.w > 0.5) {
    // open is 0 inside the slit and 1 outside it, so the wall is drawn
    // everywhere EXCEPT the gap. The first version had this inverted -- it
    // painted the gap dark and left the wall transparent, which is why forcing
    // the barrier on showed nothing at all.
    float wall = 1.0 - smoothstep(BARRIER_HALF_W * 0.65, BARRIER_HALF_W, abs(uv.x - uBarrier.x));
    float open = smoothstep(uBarrier.z * 0.82, uBarrier.z, abs(uv.y - uBarrier.y));
    col = mix(col, vec3(0.015, 0.02, 0.028), wall * open);
  }

  col *= uLumaScale;
  fragColor = vec4(col, 1.0);
}
`

export default {
  name: 'Wave Tank',
  create(canvas, seedValue) {
    let runtime = null, gl = null
    let sim = null, display = null, pp = null
    let simW = 256, simH = 128

    const rng = createRng(seedValue)
    const palettePhase = [rng.next(), 0.33 + rng.next() * 0.2, 0.67 + rng.next() * 0.2]

    // DAMPING, DERIVED RATHER THAN GUESSED.
    //
    // The old band was 0.972-0.984 per step. At 240 steps/s that leaves 0.5% of a
    // wave after ONE SECOND, and 1e-28 of it after the ~2900 steps a wave needs
    // to cross a 2048-cell tank. Interference is this saver's whole subject and it
    // was being annihilated 28 orders of magnitude before two ripples could meet
    // (#184).
    //
    // The scheme's CFL number is 0.5, so a disturbance moves sqrt(0.5) ~ 0.707
    // cells per step: one crossing is ~2900 steps, about 12s at 240 steps/s.
    // Surviving one crossing at 25% needs 0.99952; three crossings at 10% needs
    // 0.99974. That is the usable band and it is narrow -- 0.999 is already too
    // low (a wave is at 5% after one crossing) and 1.0 or above gains energy and
    // explodes. Anything outside 0.9990..0.9999 is wrong, not a matter of taste.
    //
    // Settled at the LOW end of that band, 0.99935-0.99955, which is a balance
    // rather than a maximum. At 0.99972 a wave outlives three crossings, and with
    // events arriving every few seconds the tank accumulated into exactly the
    // uniform chop #184 complains about -- measured: fine at 20s, over-energised
    // by 45s. Here the amplitude half-life is 3.5-5.3s and a wave is still at
    // ~20% after crossing the tank once, so single events stay legible and the
    // surface returns to calm between them.
    const damping = rng.range(0.99935, 0.99955)

    // Event choreography. The old version dropped every 0.55-1.4s, which kept the
    // surface in permanent uniform chop -- no single event was ever legible. Now
    // it is mostly quiet, punctuated by one deliberate event at a time.
    const gapSeconds = () => rng.range(6.0, 14.0)
    // Some activations get a barrier with a slit, so diffraction is on show.
    const barrierOn = rng.chance(0.4)
    const barrier = barrierOn
      ? [rng.range(0.48, 0.62), rng.range(0.35, 0.65), rng.range(0.035, 0.075), 1]
      : [0, 0, 0, 0]

    let elapsed = 0
    let lastTime = 0
    let nextEvent = 0
    // The running event: kind, when it started, how long it lasts, and its sites.
    let ev = null

    return {
      start() {
        runtime = createGLRuntime(canvas)
        gl = runtime.gl
        gl.getExtension('EXT_color_buffer_float')

        // Aspect-preserving: scale BOTH axes by one factor so the grid matches the
        // canvas shape. Clamping each axis on its own is what produced the 3.41:1
        // grid on a 5:1 wall.
        const wantW = canvas.width / CELL_PX
        const wantH = canvas.height / CELL_PX
        const k = Math.min(1, MAX_CELLS / Math.max(wantW, wantH))
        simW = Math.max(MIN_CELLS, Math.round(wantW * k))
        simH = Math.max(MIN_CELLS, Math.round(wantH * k))

        // Starts flat; the first drop arrives within a second.
        pp = createPingPong(gl, simW, simH, new Float32Array(simW * simH * 4))
        sim = createFullscreenPass(gl, SIM_FRAG)
        display = createFullscreenPass(gl, DISPLAY_FRAG)
        const uSim = createUniformCache(gl, sim.program)
        const uDisplay = createUniformCache(gl, display.program)
        const lumaScale = luminanceScale(canvas)

        elapsed = 0
        lastTime = 0
        // First event almost immediately, so the tank is not blank while someone
        // is looking at it -- and so the structure check has something to measure
        // at its sampled frames, which a 0 baseline says it currently does not.
        nextEvent = 0.15
        ev = null

        runtime.start((time) => {
          const dt = lastTime === 0 ? 0.016 : Math.min(time - lastTime, 0.1)
          lastTime = time
          elapsed += dt

          // EVENT CHOREOGRAPHY.
          //
          // One deliberate event at a time, separated by quiet, so the physics is
          // legible. Sites are kept off the walls so a source is not half-absorbed
          // by the reflective boundary the instant it forms.
          let srcA = [0, 0, 0, 0]
          let srcB = [0, 0, 0, 0]

          if (ev === null && elapsed >= nextEvent) {
            const r = rng.next()
            if (r < 0.42) {
              // A single large drop: one expanding ring that crosses the tank and
              // reflects off both distant end walls. On a 5:1 tank the two return
              // fronts arrive out of phase, which is the payoff #184 asks for.
              ev = { kind: 'single', t0: elapsed, dur: 0.05, x: rng.range(0.15, 0.85), y: rng.range(0.2, 0.8) }
            } else if (r < 0.75) {
              // Two continuous sources, driven in phase: a clean two-slit fringe
              // pattern. This needs a SUSTAINED drive, not an impulse -- fringes
              // are a steady-state phenomenon.
              const y0 = rng.range(0.22, 0.42)
              ev = {
                kind: 'pair',
                t0: elapsed,
                dur: rng.range(4, 7),
                x: barrierOn ? rng.range(0.12, 0.24) : rng.range(0.18, 0.32),
                y: y0,
                y2: 1.0 - y0 + rng.range(-0.05, 0.05),
                freq: rng.range(1.6, 2.6)
              }
            } else {
              // A line source sweeping in y builds a plane wave travelling in x --
              // the wavefront that makes a slit diffract visibly.
              ev = { kind: 'line', t0: elapsed, dur: rng.range(0.5, 0.8), x: rng.range(0.08, 0.16) }
            }
          }

          if (ev !== null) {
            const age = elapsed - ev.t0
            if (age > ev.dur) {
              ev = null
              nextEvent = elapsed + gapSeconds()
            } else if (ev.kind === 'single') {
              // Impulse: only on the frame it starts.
              if (age <= dt) srcA = [ev.x, ev.y, rng.range(12, 22), 0.6]
            } else if (ev.kind === 'pair') {
              // Sustained sinusoidal drive at both sites, same phase.
              const amp = 0.018 * Math.sin(age * ev.freq * Math.PI * 2)
              srcA = [ev.x, ev.y, 5, amp]
              srcB = [ev.x, ev.y2, 5, amp]
            } else {
              // Sweep the site along y across the event's duration.
              const f = Math.min(1, age / ev.dur)
              srcA = [ev.x, 0.06 + f * 0.88, 7, 0.10]
            }
          }

          // Wall-clock stepping: the same number of simulation steps per second
          // whatever the frame rate, so wave speed and decay do not depend on the
          // panel. Clamped, or a long stall would dump a burst of steps and the
          // tank would jump.
          const steps = Math.max(1, Math.min(MAX_STEPS_PER_FRAME,
            Math.round(dt * SIM_STEPS_PER_SECOND)))

          for (let i = 0; i < steps; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo)
            gl.viewport(0, 0, simW, simH)
            sim.draw((g) => {
              g.activeTexture(g.TEXTURE0)
              g.bindTexture(g.TEXTURE_2D, pp.read.tex)
              // NEAREST for the simulation: the stencil reads exact
              // neighbouring cells, and interpolating them would smear the
              // wave. The display pass sets LINEAR on this same texture, so
              // each pass must assert the filter it needs.
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
              g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
              g.uniform1i(uSim('uState'), 0)
              g.uniform2f(uSim('uTexel'), 1 / simW, 1 / simH)
              g.uniform1f(uSim('uDamping'), damping)
              // Only the first substep injects, or a source would be applied
              // once per substep at several times its intended strength.
              const a = i === 0 ? srcA : [0, 0, 0, 0]
              const b = i === 0 ? srcB : [0, 0, 0, 0]
              g.uniform4f(uSim('uSrcA'), a[0], a[1], a[2], a[3])
              g.uniform4f(uSim('uSrcB'), b[0], b[1], b[2], b[3])
              g.uniform4f(uSim('uBarrier'), barrier[0], barrier[1], barrier[2], barrier[3])
            })
            pp.swap()
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.viewport(0, 0, canvas.width, canvas.height)
          display.draw((g) => {
            g.activeTexture(g.TEXTURE0)
            g.bindTexture(g.TEXTURE_2D, pp.read.tex)
            // LINEAR for display only: the grid is coarser than the canvas, so
            // NEAREST would show hard cell blocks on the wall (#114).
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
            g.uniform1i(uDisplay('uState'), 0)
            g.uniform2f(uDisplay('uResolution'), canvas.width, canvas.height)
            g.uniform2f(uDisplay('uTexel'), 1 / simW, 1 / simH)
            g.uniform3f(uDisplay('uPhase'), palettePhase[0], palettePhase[1], palettePhase[2])
            g.uniform1f(uDisplay('uLumaScale'), lumaScale)
            g.uniform4f(uDisplay('uBarrier'), barrier[0], barrier[1], barrier[2], barrier[3])
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
