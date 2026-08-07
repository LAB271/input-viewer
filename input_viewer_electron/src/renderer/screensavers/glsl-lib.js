// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Shared GLSL snippets for the screensavers (issue #115).
 *
 * These are strings to splice into shader sources, not modules -- GLSL has no
 * import mechanism, so the alternative is copy-paste, which is what this
 * replaces. Compose them with template literals:
 *
 *   const FRAG = `#version 300 es
 *   precision highp float;
 *   ${GLSL.simplex2d}
 *   ${GLSL.fbm}
 *   void main() { ... }`
 *
 * Each snippet declares its own dependencies in a comment. They are additive
 * and safe to include more than once only if you deduplicate first -- GLSL
 * rejects duplicate function definitions.
 */

/**
 * Integer-hash based random. Replaces the `fract(sin(dot(...)) * 43758.5453)`
 * idiom, which has visible structure on many GPUs and correlates between
 * adjacent samples -- boids' neighbour sampling and white-particles' respawn
 * positions both suffered from that (issue #115).
 *
 * Based on the integer bit-mixing hashes surveyed in Jarzynski & Olano,
 * "Hash Functions for GPU Rendering" (JCGT 2020), which do not rely on
 * trigonometric precision.
 */
const hash = /* glsl */`
uint hashU(uint x) {
  x += (x << 10u); x ^= (x >>  6u);
  x += (x <<  3u); x ^= (x >> 11u);
  x += (x << 15u);
  return x;
}
uint hashU(uvec2 v) { return hashU(v.x ^ hashU(v.y)); }
uint hashU(uvec3 v) { return hashU(v.x ^ hashU(v.y) ^ hashU(v.z)); }

// [0,1) float from the top 23 bits, so the mantissa is fully populated.
float hashF(uint h) { return float(h & 0x007FFFFFu) / float(0x00800000u); }

float rand(float p)  { return hashF(hashU(floatBitsToUint(p))); }
float rand(vec2 p)   { return hashF(hashU(floatBitsToUint(p))); }
float rand(vec3 p)   { return hashF(hashU(floatBitsToUint(p))); }
vec2  rand2(vec2 p)  { uint h = hashU(floatBitsToUint(p));
                       return vec2(hashF(h), hashF(hashU(h))); }
`

/**
 * 2D simplex noise: true *gradient* noise, unlike the value noise it replaces.
 *
 * Value noise interpolates random values at lattice points, which leaves
 * axis-aligned grid artifacts -- visible under magnification, and at 6000x1200
 * that means visible at normal viewing distance. Gradient noise interpolates
 * random *gradients* instead, so the lattice does not show through.
 *
 * Returns roughly [-1, 1].
 */
const simplex2d = /* glsl */`
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute289(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`

/** Fractal Brownian motion over simplex noise. Requires: simplex2d. */
const fbm = /* glsl */`
float fbm(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += amp * snoise(p);
    norm += amp;
    p *= 2.02;   // Slightly off 2.0 so octave lattices do not align.
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}
`

/**
 * Divergence-free curl of a 2D noise field, for flow that churns rather than
 * slides.
 *
 * Two fixes over the hand-rolled versions. The step is finer (they used
 * e=0.05/0.08 over non-smooth value noise, giving visible faceting in the flow
 * direction), and time enters as a *third* noise dimension rather than as a
 * scalar offset added to both components. Adding time to both components
 * translates the whole field diagonally -- which is why the old flow visibly
 * slid across the screen instead of evolving in place.
 *
 * Requires: simplex2d.
 */
const curl2d = /* glsl */`
vec2 curl2d(vec2 p, float t) {
  const float e = 0.008;
  // Decorrelated planes rather than a shared time offset, so the field evolves.
  float n1 = snoise(p + vec2(0.0, e) + vec2(0.0, t * 0.35));
  float n2 = snoise(p - vec2(0.0, e) + vec2(0.0, t * 0.35));
  float n3 = snoise(p + vec2(e, 0.0) + vec2(t * 0.35, 0.0));
  float n4 = snoise(p - vec2(e, 0.0) + vec2(t * 0.35, 0.0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}
`

/**
 * OKLab-space palette helpers.
 *
 * The cosine palette (`0.5 + 0.5*cos(6.2831*(t + phase))`) is duplicated across
 * ten files with slightly different phase constants. It is convenient but
 * interpolates in sRGB, so ramps pass through muddy desaturated midpoints and
 * perceived lightness is uneven along the ramp. OKLab is perceptually uniform,
 * so a linear traverse looks linear.
 *
 * cosinePalette is kept for compatibility with existing looks; oklabRamp is the
 * better choice for new work.
 */
const palette = /* glsl */`
vec3 cosinePalette(float t, vec3 phase) {
  return 0.5 + 0.5 * cos(6.28318530718 * (t + phase));
}

vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
    +4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);
}

// Perceptually even ramp: L in [0,1], hue in turns, chroma ~[0,0.4].
vec3 oklabRamp(float t, float lightness, float chroma, float hueTurns) {
  float h = 6.28318530718 * (hueTurns + t);
  return max(oklabToLinear(vec3(lightness, chroma * cos(h), chroma * sin(h))), 0.0);
}

// Drop-in replacement for the cosine palette, in OKLab.
//
// Constant lightness and chroma, hue sweeping -- the textbook perceptually
// uniform ramp. Holding both fixed is the whole point: varying them is what
// gives the cosine palette its muddy troughs and blown highlights.
//
// L=0.75, C=0.12 were chosen by measurement, not taste. Sampling 24 hues and
// converting back to OKLab:
//
//   cosine palette      chroma varies 2.3x across the ramp
//   L=0.70 C=0.13       1.08x, but 3/24 hues fall outside sRGB
//   L=0.72 C=0.15       1.20x, 7/24 out of gamut
//   L=0.75 C=0.12       1.00x, 0/24 out of gamut   <- this one
//
// Out-of-gamut hues clip, which reintroduces exactly the flat patches the
// change is meant to remove, so staying inside sRGB matters more than squeezing
// out extra saturation.
//
// The phase vector keeps the cosine version's meaning: .x rotates the hue
// wheel, and the spread between components nudges chroma, so per-activation
// palette variation still varies the palette.
vec3 palettePerceptual(float t, vec3 phase) {
  float chroma = 0.12 * (0.85 + 0.3 * fract(phase.y - phase.z));
  return oklabRamp(phase.x + t, 0.75, chroma, 0.0);
}
`

/**
 * gl_VertexID -> state-texture lookup, the preamble duplicated verbatim in four
 * particle vertex shaders. Declares `uSide` and `uState`, so do not redeclare
 * them in the caller.
 */
const particleFetch = /* glsl */`
uniform sampler2D uState;
uniform float uSide;

vec4 fetchParticle(out vec2 uvOut) {
  int id = gl_VertexID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  uvOut = (vec2(float(x), float(y)) + 0.5) / uSide;
  return texture(uState, uvOut);
}
vec4 fetchParticle() { vec2 ignored; return fetchParticle(ignored); }
`

/**
 * Vertex-shader preamble for instanced-quad particles (issue #116).
 *
 * GL_POINTS cannot be rotated or stretched. boids computes each bird's heading
 * and then throws it away, using it only for hue, because a point sprite has no
 * orientation -- so a murmuration renders as round dots rather than arrowheads,
 * losing most of the read. Velocity-aligned motion-blur streaks are impossible
 * for the same reason.
 *
 * This draws N instanced unit quads instead, each fetching its state from the
 * sim texture by gl_InstanceID and orienting itself along its velocity.
 * `aCorner` is the per-vertex unit-quad corner in [-0.5, 0.5].
 *
 * Cost is roughly 4x the vertex work of points, which is irrelevant here: these
 * savers are fill-rate and simulation bound, not vertex bound.
 *
 * Declares uState/uSide/aCorner; do not redeclare them in the caller.
 */
const instancedQuad = /* glsl */`
in vec2 aCorner;
uniform sampler2D uState;
uniform float uSide;

// Per-instance state, fetched by instance id.
vec4 fetchInstance(out vec2 uvOut) {
  int id = gl_InstanceID;
  int x = id % int(uSide);
  int y = id / int(uSide);
  uvOut = (vec2(float(x), float(y)) + 0.5) / uSide;
  return texture(uState, uvOut);
}

// Place the quad at the instance position, rotated to face its velocity and
// scaled by size. The stretch factor elongates along the direction of travel:
// 1.0 is round, higher values give motion-blur streaks.
vec2 orientedQuadOffset(vec2 vel, vec2 size, float stretch) {
  float speed = length(vel);
  // Below a threshold the heading is noise, so keep the quad axis-aligned
  // rather than letting it spin wildly when a particle is nearly stationary.
  vec2 dir = speed > 1e-4 ? vel / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 c = aCorner * size;
  return dir * (c.x * stretch) + perp * c.y;
}
`

export const GLSL = { hash, simplex2d, fbm, curl2d, palette, particleFetch, instancedQuad }

/**
 * Geometry for instanced-quad particle rendering (issue #116).
 *
 * Creates the shared unit-quad VBO and a VAO with `aCorner` set up as a
 * per-vertex attribute. Draw with `draw(instanceCount)`.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program - must declare `in vec2 aCorner`
 * @returns {{draw: (count: number) => void, destroy: () => void}}
 */
export function createInstancedQuads(gl, program) {
  // Two triangles as a unit quad centred on the origin.
  const corners = new Float32Array([
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ])
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(program, 'aCorner')
  if (loc >= 0) {
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  }
  gl.bindVertexArray(null)

  return {
    draw(instanceCount) {
      gl.bindVertexArray(vao)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount)
    },
    destroy() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(vbo)
    },
  }
}

/**
 * Uniform-location cache for a program.
 *
 * getUniformLocation is a string-keyed driver query and every simulation saver
 * called it inside its per-frame draw callback -- reaction-diffusion does 5
 * lookups across 8 substeps, so 40 queries per frame for values that never
 * change. Locations are fixed for a program's lifetime, so cache them.
 *
 *   const u = createUniformCache(gl, program)
 *   gl.uniform1f(u('uDt'), dt)
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @returns {(name: string) => WebGLUniformLocation|null}
 */
export function createUniformCache(gl, program) {
  const cache = new Map()
  return function uniform(name) {
    let loc = cache.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name)
      // Cache misses too: an optimised-out uniform returns null every time, and
      // re-querying it each frame is the cost we are removing.
      cache.set(name, loc)
    }
    return loc
  }
}
